// Home page: what ResolveIT is, for anyone who isn't logged in, at "/".
//
// The first thing someone sees when the link is shared: the idea, how it works, the study's
// results, the features and the goals, with Log in and Create an account. Logged-in people get
// here from the logo, and see one button back into the app instead. Everything is drawn in HTML
// and CSS (the preview of Get help too), so nothing extra is downloaded.

import { useEffect } from 'react'
import { Link } from 'react-router'
import DemoButtons from '../components/DemoButtons.jsx'
import logo from '../assets/resolveit-logo-horizontal.svg'
import logoDark from '../assets/resolveit-logo-horizontal-dark.svg'
import './HomePage.css'

const GITHUB = 'https://github.com/esalman-dev/resolveit'

/** The four numbers from the 500-ticket study (see the README for the method). */
const RESULTS = [
  ['18.4%', 'of tickets solved with no technician'],
  ['~70%', 'of the problems a user could fix alone'],
  ['37 / 37', 'risky problems sent straight to a technician'],
  ['0', 'unsafe steps suggested in 500 tickets'],
]

const STEPS = [
  ['Describe the problem', 'In everyday words, with a screenshot if it helps. Matching how-to articles show up first.'],
  ['Try safe, simple steps', 'The AI suggests easy fixes, quickest first. Every step is checked twice: by the AI\'s rules and by the server.'],
  ['Still broken? A ticket opens', 'Already filled in: the problem, the steps you tried, a category and a priority. No starting over.'],
]

const FEATURES = [
  ['Two-layer safety check', 'Registry edits, deleting files, sharing passwords: risky fixes never reach a user. They go straight to a technician.'],
  ['A knowledge base that writes itself', 'When a technician fixes something, the AI drafts a how-to. A person checks it, and the next person finds it first.'],
  ['Dashboard and target times', 'Self-solved rate, reply and fix targets, overdue tickets and team goals, in hand-built accessible charts.'],
  ['Outage spotting', 'Three tickets about the same thing in 15 minutes? Staff confirm it, everyone sees a banner, and one fix closes them all.'],
  ['Auto-assign and notifications', 'New tickets go to the available technician with the fewest open ones, and a bell says what changed.'],
  ['New-hire checklists', 'A standard setup list, due the morning someone starts, that can\'t close until every step is done.'],
]

const GOALS = [
  ['Fewer tickets for small fixes', 'Wi-Fi, printers, Outlook: people fix the common things themselves, in minutes, any time of day.'],
  ['Never a risky step', 'Self-service only works if it\'s safe. When in doubt, a human takes over.'],
  ['Technicians start with the full story', 'Every ticket arrives with what was tried, so nobody asks "have you restarted it?" twice.'],
]

const STACK = ['React', 'Node.js + Express', 'PostgreSQL', 'Claude Haiku', 'Vitest + GitHub Actions']

/**
 * The public home page.
 * @param appHome logged in: where the app starts for you ('/tickets' or '/get-help'); logged
 *   out: not given, so Log in and Create an account (or the demo buttons) show instead
 * @param site the live-site switches: demo (show Try as… buttons), signup (show Create an account)
 * @param onLoggedIn logged out: called when a demo button logs someone in
 */
function HomePage({ appHome = null, site = { demo: false, signup: true }, onLoggedIn }) {
  const appLabel = appHome === '/tickets' ? 'Go to Tickets' : 'Go to Get help'
  // Why not usePageTitle: that one sets the app shell's header, and this page is outside the shell.
  useEffect(() => {
    document.title = 'ResolveIT · IT help that fixes itself first'
    return () => { document.title = 'ResolveIT' }
  }, [])

  return (
    <div className="home">
      <header className="home__bar">
        <div className="home__column home__bar-row">
          <Link to="/" className="home__logo">
            <img className="logo-light" src={logo} alt="ResolveIT" width="148" height="32" />
            <img className="logo-dark" src={logoDark} alt="ResolveIT" width="148" height="32" />
          </Link>
          <nav className="home__nav" aria-label="On this page">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#results">The results</a>
          </nav>
          <div className="home__bar-actions">
            {appHome ? (
              <Link className="home__cta home__cta--always" to={appHome}>{appLabel}</Link>
            ) : (
              <>
                <Link className="button-link" to="/login">Log in</Link>
                {site.demo ? (
                  <a className="home__cta" href="#try">Try the demo</a>
                ) : (
                  site.signup && <Link className="home__cta" to="/login" state={{ register: true }}>Create an account</Link>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="home__hero" aria-labelledby="home-title">
          <div className="home__column home__hero-row">
            <div className="home__hero-text">
              <p className="home__eyebrow">AI help desk · ticket deflection</p>
              <h1 id="home-title" className="home__title">Fix it before it's a ticket.</h1>
              <p className="home__lead">
                ResolveIT is an IT help desk that tries safe, simple fixes first. Describe the problem, follow a few
                checked steps, and if it's still broken, a ticket opens with everything a technician needs.
              </p>
              <div className="home__hero-actions">
                {appHome ? (
                  <Link className="home__cta home__cta--big" to={appHome}>{appLabel}</Link>
                ) : site.demo ? (
                  // The live site: one click into the app as any role, no account needed.
                  <div id="try">
                    <DemoButtons onLoggedIn={onLoggedIn} size="big" />
                  </div>
                ) : (
                  <>
                    {site.signup && <Link className="home__cta home__cta--big" to="/login" state={{ register: true }}>Create an account</Link>}
                    <Link className="button-link home__secondary" to="/login">Log in</Link>
                  </>
                )}
              </div>
            </div>
            <GetHelpPreview />
          </div>
        </section>

        <section id="results" className="home__results" aria-labelledby="home-results">
          <div className="home__column">
            <h2 id="home-results" className="visually-hidden">The results</h2>
            <ul className="home__numbers">
              {RESULTS.map(([number, words]) => (
                <li key={number}>
                  <span className="home__number">{number}</span>
                  <span className="home__number-words">{words}</span>
                </li>
              ))}
            </ul>
            <p className="home__note">From 500 simulated help desk tickets run through the app's own AI and safety check. The method and every result are in the README.</p>
          </div>
        </section>

        <section id="how" className="home__section" aria-labelledby="home-how">
          <div className="home__column">
            <h2 id="home-how" className="home__heading">How it works</h2>
            <ol className="home__steps">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="home__card">
                  <span className="home__step-number" aria-hidden="true">{i + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="features" className="home__section home__section--tinted" aria-labelledby="home-features">
          <div className="home__column">
            <h2 id="home-features" className="home__heading">A full help desk around it</h2>
            <ul className="home__features">
              {FEATURES.map(([title, text]) => (
                <li key={title} className="home__card">
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="home__section" aria-labelledby="home-why">
          <div className="home__column">
            <h2 id="home-why" className="home__heading">Why it exists</h2>
            <ul className="home__goals">
              {GOALS.map(([title, text]) => (
                <li key={title}>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
            <div className="home__stack">
              <h3 className="home__stack-heading">Built with</h3>
              <ul className="home__chips">
                {STACK.map((tool) => <li key={tool}>{tool}</li>)}
              </ul>
              <a className="button-link" href={GITHUB} target="_blank" rel="noreferrer">View the code on GitHub</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="home__footer">
        <div className="home__column home__footer-row">
          <span>ResolveIT, a portfolio project by E. Salman</span>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  )
}

/**
 * A still picture of Get help, drawn in HTML: a problem, three steps (two ticked) and "That
 * fixed it". aria-hidden: it's decoration; the words around it say the same thing.
 */
function GetHelpPreview() {
  const steps = [
    ['Turn Wi-Fi off and on again', true],
    ['Forget the network and rejoin it', true],
    ['Restart the laptop', false],
  ]
  return (
    <div className="home__preview" aria-hidden="true">
      <div className="home__preview-card">
        <p className="home__preview-label">Get help</p>
        <p className="home__preview-problem">Laptop won't connect to Wi-Fi</p>
        <p className="home__preview-hint">Try these steps, easiest first:</p>
        <ul className="home__preview-steps">
          {steps.map(([text, done], i) => (
            <li key={text} className={done ? 'is-done' : undefined}>
              <span className="home__preview-box">{done ? '✓' : ''}</span>
              {i + 1}. {text}
            </li>
          ))}
        </ul>
        <div className="home__preview-buttons">
          <span className="home__preview-fixed">That fixed it</span>
          <span className="home__preview-broken">Still broken</span>
        </div>
      </div>
      <div className="home__preview-toast">✓ Fixed in 2 minutes, no ticket needed</div>
    </div>
  )
}

export default HomePage
