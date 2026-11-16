// Rate limiting: caps how many requests one IP address can make in a time window.
//
// Stops password guessing (brute force) and anyone hammering the API to slow it down.
// Counters live in memory, so they reset when the server restarts.

import { rateLimit } from 'express-rate-limit';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Turns the limits off for the automated tests, which create dozens of accounts in seconds.
 *
 * Security: both variables must be set, so one stray setting can't switch the limits off in
 * production. test/rateLimit.test.js turns the limits back on to test them.
 */
const skip = () => process.env.NODE_ENV === 'test' && process.env.DISABLE_RATE_LIMIT === '1';

/**
 * Strict limit for routes that check a password: 10 failed attempts per 15 minutes.
 * Plenty for a person who mistyped, useless for a guessing script.
 */
export const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  skipSuccessfulRequests: true, // only failed attempts count, so normal logins never get blocked
  standardHeaders: 'draft-8', // tells the client its limit through a RateLimit header
  legacyHeaders: false,
  skip,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

/**
 * Sign-up limit: 10 accounts per hour. Every request counts (successful ones too),
 * so a script can't mass-create accounts.
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip,
  message: { error: 'Too many accounts created. Please try again in an hour.' },
});

/** General limit for every other API request: high enough that normal use never hits it. */
export const apiLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});
