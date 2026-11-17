// Count cards: a row of "number + label" cards that also work as filter buttons.
//
// Used by the AI help screen (results) and the staff ticket list (status). One component, so
// both screens look and behave the same.

import './CountCards.css'

/**
 * Shows one card per item. Clicking a card selects it (a filter); clicking the selected card
 * again clears it.
 *
 * @param {Array<{ value: string, label: string, count: number, tone: string }>} cards
 *   tone: the colored edge: 'green', 'orange', 'blue', 'amber', 'gray', 'red' or 'indigo'
 * @param {string} selected the value of the selected card, or ''
 * @param {(value: string) => void} onSelect called with the clicked value, or '' to clear
 * @param {string} label what the cards filter, for screen readers (e.g. "Filter by result")
 */
function CountCards({ cards, selected, onSelect, label }) {
  return (
    <div className="count-cards" role="group" aria-label={label}>
      {cards.map((card) => (
        <button
          key={card.value}
          type="button"
          className={`count-card count-card--${card.tone}`}
          aria-pressed={selected === card.value} // screen readers say "pressed" for the active filter
          onClick={() => onSelect(selected === card.value ? '' : card.value)}
        >
          <span className="count-card__number">{card.count}</span>
          <span className="count-card__label">{card.label}</span>
        </button>
      ))}
    </div>
  )
}

export default CountCards
