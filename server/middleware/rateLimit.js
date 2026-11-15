// Rate limiting: caps how many requests one IP address can make in a time window.
// Stops password guessing ("brute force") and someone hammering the API to slow it down.
import { rateLimit } from 'express-rate-limit';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Strict: endpoints that check a password or create accounts.
// 10 tries per 15 minutes is plenty for a human who mistyped, and useless for a guessing script
// (it would take years to get through even a small password list).
export const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  skipSuccessfulRequests: true, // only FAILED attempts count, so normal logins never get blocked
  standardHeaders: 'draft-8',   // tells the client its limit via a RateLimit header
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

// Sign-ups: here EVERY request counts (successful ones too), so a script can't mass-create accounts.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many accounts created. Please try again in an hour.' },
});

// Loose: every other API request. High enough that normal use never hits it.
export const apiLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});
