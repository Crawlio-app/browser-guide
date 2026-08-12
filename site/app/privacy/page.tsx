export const metadata = {
  title: "Privacy Policy — Crawlio Browser Guide",
};

export default function Privacy() {
  return (
    <div className="page">
      <header className="hero">
        <p className="kicker">Crawlio Browser Guide</p>
        <h1>Privacy Policy</h1>
        <p className="hero-line">
          Browser Guide is built so that the honest answer to &ldquo;where does my data
          go?&rdquo; is short. This page is that answer in full.
        </p>
      </header>

      <main className="content" style={{ gridColumn: "1 / -1", maxWidth: 720 }}>
        <section id="summary">
          <h2>Summary</h2>
          <ul>
            <li><strong>No servers of ours.</strong> Browser Guide has no backend, no analytics, no telemetry, and no accounts. We never see your data.</li>
            <li><strong>One recipient.</strong> Page evidence, questions, and voice audio go directly from your browser to OpenAI&rsquo;s Realtime API, using your own API key, only when you ask a question.</li>
            <li><strong>Key in macOS Keychain.</strong> Your OpenAI API key is stored by a local helper via Security.framework. It never enters Chrome storage, sync, source, or logs.</li>
          </ul>
        </section>

        <section id="collection">
          <h2>What the extension accesses</h2>
          <ul>
            <li><strong>Page snapshot</strong> — captured only after you click the toolbar icon on a page and ask something. It is a bounded accessibility outline (roles, names, visible text; ~12,000 characters max). Input values, passwords, cookies, storage, network traffic, and hidden form values are always excluded.</li>
            <li><strong>Screenshots</strong> — only when you enable the Visual toggle, and omitted entirely (fail-closed) when a visible input field, code block, or likely-sensitive content is present.</li>
            <li><strong>Microphone</strong> — only while you are speaking to the guide after pressing the voice beacon. Audio streams to OpenAI over WebRTC and is never recorded or stored by the extension.</li>
          </ul>
        </section>

        <section id="storage">
          <h2>What is stored, and where</h2>
          <ul>
            <li><strong>OpenAI API key</strong> — macOS Keychain, written and read by the local native helper. Removable anytime with the key button in the panel.</li>
            <li><strong>Session state</strong> — which tab you shared, kept in Chrome&rsquo;s in-memory session storage and gone when Chrome closes. Conversations exist only in the open panel and are never persisted.</li>
          </ul>
        </section>

        <section id="third-parties">
          <h2>Third parties</h2>
          <p>
            The only third party is <strong>OpenAI</strong>, which receives your questions, the
            sanitized page evidence, optional screenshots, and voice audio under your own API
            key and OpenAI&rsquo;s own <a href="https://openai.com/policies/">terms and privacy policy</a>.
            Nothing is sent anywhere else — the extension has no network client of its own and
            its pages declare <code>connect-src &lsquo;none&rsquo;</code>.
          </p>
        </section>

        <section id="verify">
          <h2>Verify it yourself</h2>
          <p>
            Browser Guide is open source under Apache 2.0. The claims above are enforced by an
            automated forbidden-capability guard and end-to-end tests you can run yourself:{" "}
            <a href="https://github.com/Crawlio-app/browser-guide">github.com/Crawlio-app/browser-guide</a>.
          </p>
          <p>
            Questions or concerns: <a href="mailto:rashid.azarang.eg@gmail.com">rashid.azarang.eg@gmail.com</a>.
          </p>
        </section>
      </main>

      <footer className="footer">
        <span>
          <i aria-hidden="true" />
          Crawlio Browser Guide — reads, explains, points. Never acts.
        </span>
        <span>
          <a href="/">Docs</a>
          {" · by "}
          <a href="https://www.crawlio.app">Crawlio</a>
        </span>
      </footer>
    </div>
  );
}
