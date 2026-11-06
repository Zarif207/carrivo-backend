import Stripe from "stripe";
import { env } from "../config/env.js";

/**
 * Stripe client, pinned to the API version stripe@23.0.1 ships with, so request
 * and response shapes never change underneath us. Retries are safe because every
 * write we make carries an idempotency key.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
  maxNetworkRetries: 2,
  timeout: 10_000,
  appInfo: { name: "carrivo-backend" },
});

export type { Stripe };
