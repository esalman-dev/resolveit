// Stars: a 1-5 star rating, shown (Stars) or chosen (StarPicker).

import { useId } from 'react'
import './Stars.css'

/**
 * Shows a rating as five stars, filled up to `stars`. Screen readers hear "4 of 5 stars".
 * @example <Stars stars={4} />
 */
export function Stars({ stars }) {
  return (
    <span className="stars" role="img" aria-label={`${stars} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= stars ? 'stars__star stars__star--on' : 'stars__star'} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  )
}

const WORDS = { 1: 'Poor', 2: 'Not great', 3: 'OK', 4: 'Good', 5: 'Excellent' }

/**
 * Five star buttons to choose a rating.
 * Why radio buttons under the stars: arrow keys move between them and screen readers say
 * "3 of 5 stars, OK", the way a real rating control should work, without extra code.
 *
 * @param {number} value the chosen rating, or 0 for none yet
 * @param {(stars: number) => void} onChange
 */
export function StarPicker({ value, onChange, disabled = false, label = 'Your rating' }) {
  const name = useId()
  return (
    <fieldset className="star-picker" disabled={disabled}>
      <legend className="star-picker__legend">{label}</legend>
      <div className="star-picker__stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n <= value ? 'star-picker__star star-picker__star--on' : 'star-picker__star'}>
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              aria-label={`${n} of 5 stars, ${WORDS[n]}`}
            />
            <span aria-hidden="true">★</span>
          </label>
        ))}
        {value > 0 && <span className="star-picker__word">{WORDS[value]}</span>}
      </div>
    </fieldset>
  )
}
