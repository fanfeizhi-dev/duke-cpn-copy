import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import {
  NormalizedQuote,
  NormalizedOfframpResult,
  NormalizedWebhookEvent,
  NormalizedPaymentStatus,
  OfframpParams,
  QuoteParams,
  PaymentStatus,
} from '../../src/providers/provider-normalized.types';
import { ILiquidityProvider } from '../../src/providers/provider.interface';

@Injectable()
export class CircleProvider implements ILiquidityProvider {
  readonly providerId = 'circle';
  private readonly client: AxiosInstance;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('CIRCLE_API_KEY');
    const baseUrl =
      this.configService.get<string>('CIRCLE_API_BASE_URL') ||
      'https://api.circle.com/v1';
    this.webhookSecret =
      this.configService.get<string>('CIRCLE_WEBHOOK_SECRET') || '';

    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  async getQuote(params: QuoteParams): Promise<NormalizedQuote> {
    const response = await this.client.post('/payments/quotes', {
      sourceCurrency: params.fromCurrency,
      destinationCurrency: params.toCurrency,
      sourceAmount: params.fromAmount || undefined,
      destinationAmount: params.toAmount || undefined,
      network: params.network,
      ...params.corridorConfig,
    });

    const quote = response.data?.data || response.data;

    return {
      quoteId: quote.id || quote.quoteId,
      provider: this.providerId,
      fromCurrency: params.fromCurrency,
      toCurrency: params.toCurrency,
      fromAmount: quote.sourceAmount?.amount || quote.fromAmount || params.fromAmount || '0',
      toAmount: quote.destinationAmount?.amount || quote.toAmount || params.toAmount || '0',
      expiration: quote.expiresAt || quote.expiration || new Date(Date.now() + 30000).toISOString(),
      rate: quote.exchangeRate || quote.rate,
      network: params.network,
      rawQuote: quote,
    };
  }

  async createOfframp(params: OfframpParams): Promise<NormalizedOfframpResult> {
    const rawQuote = params.rawQuote as Record<string, unknown>;

    const response = await this.client.post(
      '/payments',
      {
        quoteId: params.quoteId,
        source: {
          type: 'blockchain',
          address: params.senderAddress,
          ...(params.refundAddress ? { refundAddress: params.refundAddress } : {}),
        },
        originator: params.originator,
        beneficiary: params.beneficiary,
        idempotencyKey: params.idempotencyKey,
        ...(params.customerRefId ? { customerRefId: params.customerRefId } : {}),
        ...(params.reasonForPayment ? { reasonForPayment: params.reasonForPayment } : {}),
      },
      {
        headers: {
          'Idempotency-Key': params.idempotencyKey,
        },
      },
    );

    const payment = response.data?.data || response.data;

    return {
      offrampId: payment.id || payment.paymentId,
      provider: this.providerId,
      depositAddress: payment.depositAddress?.address || payment.depositAddress || undefined,
      transactionId: payment.transactionHash || payment.transactionId || undefined,
      transactionSubmitted: false,
      network: (rawQuote?.network as string) || '',
      createdAt: payment.createDate || payment.createdAt || new Date().toISOString(),
    };
  }

  async submitTransaction(
    paymentId: string,
    transactionId: string,
  ): Promise<{ submitted: boolean }> {
    try {
      await this.client.post(
        `/payments/${paymentId}/blockchain-transaction`,
        {
          transactionHash: transactionId,
        },
      );

      return { submitted: true };
    } catch {
      try {
        await this.client.put(`/payments/${paymentId}`, {
          transactionHash: transactionId,
        });
        return { submitted: true };
      } catch {
        return { submitted: false };
      }
    }
  }

  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): boolean {
    if (!this.webhookSecret) {
      return true;
    }

    const signature =
      headers['x-circle-signature'] ||
      headers['X-Circle-Signature'] ||
      headers['x-signature'];

    if (!signature) {
      return false;
    }

    const signatureStr = Array.isArray(signature) ? signature[0] : signature;
    if (!signatureStr) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signatureStr),
      Buffer.from(expectedSignature),
    );
  }

  parseWebhookEvent(payload: unknown): NormalizedWebhookEvent {
    const event = payload as Record<string, unknown>;
    const notificationBody = (event.notification || event) as Record<string, unknown>;
    const paymentData = (notificationBody.payment ||
      notificationBody.data ||
      notificationBody) as Record<string, unknown>;

    const eventType =
      (event.type as string) ||
      (event.notificationType as string) ||
      (notificationBody.type as string) ||
      'unknown';

    const paymentId =
      (paymentData.id as string) ||
      (paymentData.paymentId as string) ||
      (event.paymentId as string) ||
      '';

    const rawStatus =
      (paymentData.status as string) ||
      (event.status as string) ||
      '';

    return {
      eventId: (event.id as string) || (event.eventId as string) || undefined,
      paymentId,
      eventType,
      derivedStatus: this.mapStatus(rawStatus),
    };
  }

  async getPaymentStatus(paymentId: string): Promise<NormalizedPaymentStatus> {
    const response = await this.client.get(`/payments/${paymentId}`);

    const payment = response.data?.data || response.data;
    const rawStatus = payment.status || '';

    return {
      paymentId,
      provider: this.providerId,
      status: this.mapStatus(rawStatus),
      rawStatus,
    };
  }

  private mapStatus(status: string): PaymentStatus {
    const normalized = (status || '').toLowerCase().replace(/[\s_-]+/g, '_');

    switch (normalized) {
      case 'created':
      case 'pending':
      case 'action_required':
        return PaymentStatus.CREATED;
      case 'awaiting_funds':
      case 'awaiting_deposit':
      case 'waiting_for_deposit':
        return PaymentStatus.AWAITING_FUNDS;
      case 'funds_received':
      case 'deposit_received':
      case 'funded':
        return PaymentStatus.FUNDS_RECEIVED;
      case 'processing':
      case 'in_progress':
      case 'confirming':
      case 'settling':
        return PaymentStatus.PROCESSING;
      case 'completed':
      case 'complete':
      case 'paid':
      case 'settled':
      case 'success':
        return PaymentStatus.COMPLETED;
      case 'failed':
      case 'failure':
      case 'error':
      case 'rejected':
        return PaymentStatus.FAILED;
      case 'canceled':
      case 'cancelled':
      case 'expired':
      case 'refunded':
        return PaymentStatus.CANCELED;
      default:
        return PaymentStatus.UNKNOWN;
    }
  }
}