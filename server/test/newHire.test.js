// Tests for the wording of new-hire tickets (services/newHire.js).

import { describe, it, expect } from 'vitest';
import { newHireTitle } from '../services/newHire.js';

describe('newHireTitle', () => {
  it('puts the name and job title after "New hire:"', () => {
    expect(newHireTitle({ name: 'Jane Doe', jobTitle: 'Sales Associate' })).toBe('New hire: Jane Doe, Sales Associate');
  });

  it('works with other names too (not just the example)', () => {
    expect(newHireTitle({ name: 'Omar Haddad', jobTitle: 'IT Technician' })).toBe('New hire: Omar Haddad, IT Technician');
  });
});
