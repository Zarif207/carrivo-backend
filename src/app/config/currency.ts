/**
 * THE platform currency. Every price, payment and report uses it, and Stripe
 * charges in it. The Prisma column defaults ("usd") must match this value.
 */
export const PLATFORM_CURRENCY = "usd" as const;
export type PlatformCurrency = typeof PLATFORM_CURRENCY;

/** USD is a two-decimal currency: 1 dollar = 100 cents (Stripe's smallest unit). */
export const MINOR_UNITS_PER_MAJOR = 100;

/** Stripe's minimum charge for USD (docs.stripe.com/currencies#minimum-and-maximum-charge-amounts). */
export const STRIPE_MIN_CHARGE = "0.50";
