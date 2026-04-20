import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { ILiquidityProvider } from '../../src/providers/provider.interface';
import {
  NormalizedQuote,
  NormalizedOfframpResult,
  NormalizedWebhookEvent,
  NormalizedPaymentStatus,
  OfframpParams,
  QuoteParams,
  PaymentStatus,
} from '../../src/providers/provider-normalized.types';

@Injectable()
export class CircleProvider implements ILiquidityProvider {
  readonly providerId = 'circle';
  private readonly client: AxiosInstance;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('CIRCLE_API_KEY') || '';
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

    const data = response.data?.data || response.data;

    return {
      quoteId: data.id || data.quoteId || '',
      provider: this.providerId,
      fromCurrency: data.sourceCurrency || params.fromCurrency,
      toCurrency: data.destinationCurrency || params.toCurrency,
      fromAmount: data.sourceAmount?.amount || data.sourceAmount || params.fromAmount || '',
      toAmount: data.destinationAmount?.amount || data.destinationAmount || params.toAmount || '',
      expiration: data.expiresAt || data.expiration || '',
      rate: data.exchangeRate || data.rate || undefined,
      network: params.network,
      rawQuote: data,
    };
  }

  async createOfframp(params: OfframpParams): Promise<NormalizedOfframpResult> {
    const rawQuote = params.rawQuote as Record<string, unknown>;

    const response = await this.client.post('/payments', {
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
      ...(params.useCase ? { useCase: params.useCase } : {}),
    });

    const data = response.data?.data || response.data;

    return {
      offrampId: data.id || data.paymentId || '',
      provider: this.providerId,
      depositAddress: data.depositAddress || data.source?.address || undefined,
      transactionId: data.transactionId || data.transactionHash || undefined,
      transactionSubmitted: false,
      network: (rawQuote?.network as string) || '',
      createdAt: data.createDate || data.createdAt || new Date().toISOString(),
    };
  }

  async submitTransaction(
    paymentId: string,
    transactionId: string,
  ): Promise<{ submitted: boolean }> {
    try {
      await this.client.put(`/payments/${paymentId}/transaction`, {
        transactionHash: transactionId,
      });

      return { submitted: true };
    } catch {
      try {
        await this.client.post(`/payments/${paymentId}/submit`, {
          transactionId,
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

    const sigString = Array.isArray(signature) ? signature[0] : signature;
    if (!sigString) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(sigString),
        Buffer.from(expectedSignature),
      );
    } catch {
      return false;
    }
  }

  parseWebhookEvent(payload: unknown): NormalizedWebhookEvent {
    const event = payload as Record<string, unknown>;
    const notificationBody =
      (event.notification as Record<string, unknown>) || event;
    const paymentData =
      (notificationBody.payment as Record<string, unknown>) ||
      (notificationBody.data as Record<string, unknown>) ||
      event;

    const paymentId =
      (paymentData.id as string) ||
      (paymentData.paymentId as string) ||
      (event.paymentId as string) ||
      '';

    const rawStatus =
      (paymentData.status as string) ||
      (event.status as string) ||
      (notificationBody.status as string) ||
      '';

    const eventType =
      (event.type as string) ||
      (event.eventType as string) ||
      (notificationBody.type as string) ||
      'payment.updated';

    return {
      eventId: (event.id as string) || (event.eventId as string) || undefined,
      paymentId,
      eventType,
      derivedStatus: this.mapStatus(rawStatus),
    };
  }

  async getPaymentStatus(paymentId: string): Promise<NormalizedPaymentStatus> {
    const response = await this.client.get(`/payments/${paymentId}`);
    const data = response.data?.data || response.data;

    const rawStatus = data.status || '';

    return {
      paymentId,
      provider: this.providerId,
      status: this.mapStatus(rawStatus),
      rawStatus,
    };
  }

  private mapStatus(status: string): PaymentStatus {
    const normalized = (status || '').toLowerCase().replace(/[\s_-]/g, '');

    switch (normalized) {
      case 'created':
      case 'pending':
      case 'new':
        return PaymentStatus.CREATED;

      case 'awaitingfunds':
      case 'awaitingdeposit':
      case 'actionrequired':
      case 'waitingfordeposit':
        return PaymentStatus.AWAITING_FUNDS;

      case 'fundsreceived':
      case 'deposited':
      case 'received':
        return PaymentStatus.FUNDS_RECEIVED;

      case 'processing':
      case 'inprogress':
      case 'settling':
      case 'confirming':
        return PaymentStatus.PROCESSING;

      case 'complete':
      case 'completed':
      case 'settled':
      case 'paid':
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