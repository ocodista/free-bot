/**
 * What Free-bot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        <span>Free-bot</span>
      </div>
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up Free-bot
        </button>
      </div>
      <p className="footnote">
        No platform account is required. Install local software, then choose
        your AI provider or a local model endpoint.
      </p>
    </div>
  );
}
