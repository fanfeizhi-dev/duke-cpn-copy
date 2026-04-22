import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import {
  NormalizedQuote,
  NormalizedOfframpResult,
  NormalizedWebhookEvent,
  NormalizedPaymentStatus,
  PaymentStatus,
  OfframpParams,
  QuoteParams,
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
      fromAmount: quote.sourceAmount?.amount || quote.sourceAmount || params.fromAmount || '0',
      toAmount: quote.destinationAmount?.amount || quote.destinationAmount || params.toAmount || '0',
      expiration: quote.expiresAt || quote.expiration || new Date(Date.now() + 30000).toISOString(),
      rate: quote.exchangeRate || quote.rate,
      network: params.network,
      rawQuote: quote,
    };
  }

  async createOfframp(params: OfframpParams): Promise<NormalizedOfframpResult> {
    const response = await this.client.post(
      '/payments',
      {
        quoteId: params.quoteId,
        senderAddress: params.senderAddress,
        originator: params.originator,
        beneficiary: params.beneficiary,
        refundAddress: params.refundAddress,
        customerRefId: params.customerRefId,
        useCase: params.useCase,
        reasonForPayment: params.reasonForPayment,
        idempotencyKey: params.idempotencyKey,
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
      depositAddress: payment.depositAddress || payment.senderAddress || undefined,
      transactionId: payment.transactionId || payment.txHash || undefined,
      transactionSubmitted: false,
      network: payment.network || payment.chain || '',
      createdAt: payment.createDate || payment.createdAt || new Date().toISOString(),
    };
  }

  async submitTransaction(
    paymentId: string,
    transactionId: string,
  ): Promise<{ submitted: boolean }> {
    const response = await this.client.post(
      `/payments/${paymentId}/transaction`,
      {
        transactionId,
        txHash: transactionId,
      },
    );

    const data = response.data?.data || response.data;
    return {
      submitted: data?.submitted ?? true,
    };
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

    const sigString = Array.isArray(signature) ? signature[0] : signature;
    if (!sigString) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(sigString),
      Buffer.from(expectedSignature),
    );
  }

  parseWebhookEvent(payload: unknown): NormalizedWebhookEvent {
    const event = payload as Record<string, any>;
    const notificationBody = event.notification || event;
    const paymentData =
      notificationBody.payment ||
      notificationBody.data ||
      notificationBody;

    const paymentId =
      paymentData.id ||
      paymentData.paymentId ||
      notificationBody.paymentId ||
      '';

    const rawStatus =
      paymentData.status ||
      notificationBody.status ||
      '';

    const eventType =
      notificationBody.notificationType ||
      notificationBody.type ||
      notificationBody.eventType ||
      'unknown';

    return {
      eventId: notificationBody.id || notificationBody.eventId || undefined,
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

  private mapStatus(rawStatus: string): PaymentStatus {
    const normalized = (rawStatus || '').toLowerCase().replace(/[\s_-]/g, '');

    switch (normalized) {
      case 'created':
      case 'pending':
      case 'initiated':
        return PaymentStatus.CREATED;

      case 'awaitingfunds':
      case 'awaitingdeposit':
      case 'actionrequired':
        return PaymentStatus.AWAITING_FUNDS;

      case 'fundsreceived':
      case 'deposited':
        return PaymentStatus.FUNDS_RECEIVED;

      case 'processing':
      case 'inprogress':
      case 'settling':
        return PaymentStatus.PROCESSING;

      case 'completed':
      case 'complete':
      case 'paid':
      case 'settled':
      case 'confirmed':
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