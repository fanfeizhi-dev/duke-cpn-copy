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
    const response = await this.client.post('/cpn/quotes', {
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
      fromCurrency: quote.sourceCurrency || params.fromCurrency,
      toCurrency: quote.destinationCurrency || params.toCurrency,
      fromAmount: String(quote.sourceAmount || params.fromAmount || '0'),
      toAmount: String(quote.destinationAmount || params.toAmount || '0'),
      expiration: quote.expiresAt || quote.expiration || '',
      rate: quote.rate ? String(quote.rate) : undefined,
      network: params.network,
      rawQuote: quote,
    };
  }

  async createOfframp(params: OfframpParams): Promise<NormalizedOfframpResult> {
    const response = await this.client.post(
      '/cpn/payments',
      {
        quoteId: params.quoteId,
        senderAddress: params.senderAddress,
        originator: params.originator,
        beneficiary: params.beneficiary,
        refundAddress: params.refundAddress,
        customerRefId: params.customerRefId,
        useCase: params.useCase,
        reasonForPayment: params.reasonForPayment,
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
      depositAddress: payment.depositAddress || payment.senderAddress,
      transactionId: payment.transactionId || undefined,
      transactionSubmitted: !!payment.transactionId,
      network: payment.network || '',
      createdAt: payment.createDate || payment.createdAt || new Date().toISOString(),
    };
  }

  async submitTransaction(
    paymentId: string,
    transactionId: string,
  ): Promise<{ submitted: boolean }> {
    const response = await this.client.put(
      `/cpn/payments/${paymentId}/transaction`,
      {
        transactionId,
      },
    );

    const result = response.data?.data || response.data;
    return {
      submitted: result?.status === 'submitted' || response.status === 200 || response.status === 202,
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

    const eventType =
      notificationBody.type ||
      notificationBody.eventType ||
      event.type ||
      'unknown';

    const rawStatus =
      paymentData.status ||
      notificationBody.status ||
      '';

    return {
      eventId: notificationBody.id || event.id,
      paymentId: String(paymentId),
      eventType: String(eventType),
      derivedStatus: this.mapStatus(String(rawStatus)),
    };
  }

  async getPaymentStatus(paymentId: string): Promise<NormalizedPaymentStatus> {
    const response = await this.client.get(`/cpn/payments/${paymentId}`);

    const payment = response.data?.data || response.data;
    const rawStatus = payment.status || '';

    return {
      paymentId,
      provider: this.providerId,
      status: this.mapStatus(rawStatus),
      rawStatus: String(rawStatus),
    };
  }

  private mapStatus(rawStatus: string): PaymentStatus {
    const normalized = rawStatus.toLowerCase().replace(/[_\s-]/g, '');

    switch (normalized) {
      case 'created':
      case 'pending':
      case 'initiated':
        return PaymentStatus.CREATED;

      case 'awaitingfunds':
      case 'awaitingdeposit':
      case 'actionrequired':
      case 'awaitingpayment':
        return PaymentStatus.AWAITING_FUNDS;

      case 'fundsreceived':
      case 'deposited':
      case 'received':
        return PaymentStatus.FUNDS_RECEIVED;

      case 'processing':
      case 'inprogress':
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