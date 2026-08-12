const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "install", label: "Install" },
  { id: "setup", label: "Setup wizard" },
  { id: "using", label: "Using the guide" },
  { id: "voice", label: "Voice" },
  { id: "privacy", label: "Privacy & security" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

export default function Docs() {
  return (
    <div className="page">
      <header className="hero">
        <span className="hero-beacon" aria-hidden="true">
          <i />
        </span>
        <p className="kicker">Crawlio Browser Guide · Docs</p>
        <h1>
          A guide that points,
          <br />
          never touches.
        </h1>
        <p className="hero-line">
          Browser Guide is a Chrome side panel that explains the page in front of you and
          visually points to the right control. It <strong>never clicks, types, or
          navigates</strong> — you stay in charge of every action. The only thing it moves is
          the view, and only when you press its take-me-there arrow.
        </p>
      </header>

      <aside className="side">
        <p className="side-label">On this page</p>
        <nav aria-label="Sections">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </nav>
      </aside>

      <main className="content">
        <section id="overview">
          <h2>Overview</h2>
          <p>
            Browser Guide has three intents — <strong>Ask</strong>, <strong>Find</strong>, and{" "}
            <strong>Walkthrough</strong> — plus a voice beacon for spoken questions. It reads a
            bounded, sanitized snapshot of the page you explicitly share and answers over a
            private OpenAI Realtime connection created by a local macOS helper.
          </p>
          <div className="callout">
            <span className="callout-dot" aria-hidden="true" />
            <p>
              Your OpenAI API key lives in <strong>macOS Keychain</strong>, never in Chrome.
              Page evidence goes only to OpenAI, only when you ask a question.
            </p>
          </div>
        </section>

        <section id="install">
          <h2>Install</h2>
          <p>Browser Guide is an internal build, loaded unpacked from the project directory.</p>
          <pre>
            <code>{`cd ~/Desktop/browser-guide
npm install
npm run build
npm run install:helper`}</code>
          </pre>
          <ol className="step-cards">
            <li>
              <h4>Load the extension</h4>
              <p>
                Open <code>chrome://extensions</code>, enable Developer mode, choose{" "}
                <strong>Load unpacked</strong>, and select <code>dist/extension</code>.
              </p>
            </li>
            <li>
              <h4>The setup wizard opens</h4>
              <p>
                On first install Browser Guide opens its onboarding wizard in a new tab. You can
                reopen it anytime from the extension&rsquo;s <strong>Options</strong>.
              </p>
            </li>
            <li>
              <h4>Pin the toolbar icon</h4>
              <p>Pin Browser Guide so its toolbar control stays visible — one click shares the current page.</p>
            </li>
          </ol>
        </section>

        <section id="setup">
          <h2>Setup wizard</h2>
          <p>The wizard walks through three permissions, one decision at a time. Each step shows its live status.</p>
          <ol className="step-cards">
            <li>
              <h4>Allow the local helper</h4>
              <p>
                Chrome asks once for the <code>nativeMessaging</code> permission so the extension
                can reach the Browser Guide helper on your Mac. Nothing leaves your computer.
              </p>
            </li>
            <li>
              <h4>Add your OpenAI key</h4>
              <p>
                Paste a newly issued OpenAI Platform key. The helper writes it straight to macOS
                Keychain with Security.framework — Chrome never stores it, and the field clears
                immediately.
              </p>
            </li>
            <li>
              <h4>Allow the microphone (optional)</h4>
              <p>
                Only needed for voice. Chrome prompts near the address bar; typed questions work
                without it. If Chrome has blocked it before, the wizard shows the exact settings
                address to flip it back to Allow.
              </p>
            </li>
          </ol>
          <div className="callout warn">
            <span className="callout-dot" aria-hidden="true" />
            <p>
              Any API key that was ever pasted into a chat, terminal command, or source file
              should be revoked and reissued before use.
            </p>
          </div>
        </section>

        <section id="using">
          <h2>Using the guide</h2>
          <p>
            Open any normal website and click the Browser Guide toolbar icon. That single click
            grants temporary access to the current page and opens the side panel.
          </p>
          <div className="mode-table">
            <div className="mode-row">
              <span className="mode-name">Ask</span>
              <p>Explains the current page — what it is, what each section does, where to look next.</p>
            </div>
            <div className="mode-row">
              <span className="mode-name">Find</span>
              <p>
                Locates the best current match for what you describe and places a pointer-transparent
                emerald beacon over it.
              </p>
            </div>
            <div className="mode-row">
              <span className="mode-name">Walkthrough</span>
              <p>
                Select it and the tour starts by itself: the guide reads the page, tells you what
                it is, and walks you through it one step at a time with a friendly compass
                companion. Each on-page step card shows your progress and a <strong>Next</strong>{" "}
                button — the final <strong>Done</strong> closes the tour. If a target is
                off-screen, press the arrow cue and the page scrolls to it.
              </p>
            </div>
          </div>
          <h3>Good to know</h3>
          <ul>
            <li>
              Chrome never grants access on internal pages (<code>chrome://</code>), the Chrome Web
              Store, or other restricted surfaces.
            </li>
            <li>Navigating to a different site pauses the guide — click the toolbar icon again to share the new page.</li>
            <li>
              The <strong>Visual</strong> toggle adds a screenshot to your question. It is opt-in
              and fail-closed: any visible input field, code block, or likely-sensitive content
              omits the image entirely.
            </li>
          </ul>
        </section>

        <section id="voice">
          <h2>Voice</h2>
          <p>
            Click the emerald voice beacon — or press <code>⌘⇧G</code> or <code>⌘⇧Space</code> —
            to talk. Audio streams from your Mac directly to OpenAI over WebRTC; the local helper
            only brokers the session and never hears you.
          </p>
          <ul>
            <li>The first click opens the microphone step of the wizard if permission is missing.</li>
            <li>
              Remap either shortcut at <code>chrome://extensions/shortcuts</code>. Chrome does not
              permit <code>⌘⌥</code> combinations for extensions.
            </li>
            <li>The microphone turns on only while you are speaking to the guide, and everything closes when the panel closes or access pauses.</li>
            <li>Answers are always in English and stay short by default — ask for detail when you want more.</li>
          </ul>
        </section>

        <section id="privacy">
          <h2>Privacy &amp; security</h2>
          <ul>
            <li>A page snapshot is captured only after explicit activation and a question — capped at 300 candidates and ~12,000 characters.</li>
            <li>Input values, passwords, cookies, storage, network traffic, and hidden form values are always excluded.</li>
            <li>The model has exactly two tools: <code>show_guidance</code> and <code>clear_guidance</code>. Neither can act on the page.</li>
            <li>The overlay is a closed shadow root with <code>pointer-events:&nbsp;none</code> — it registers no page listeners.</li>
            <li>The extension has no debugger access, no network client, no host permissions, and stores nothing in Chrome beyond session state.</li>
            <li>An automated forbidden-capability guard verifies every build: zero clicks, inputs, key events, submits, focus changes, scrolls, or navigation.</li>
          </ul>
        </section>

        <section id="troubleshooting">
          <h2>Troubleshooting</h2>
          <h3>&ldquo;This tab isn&rsquo;t shared yet&rdquo;</h3>
          <p>Click the Browser Guide toolbar icon once on the page you want to share. Opening the panel from Chrome&rsquo;s side-panel menu doesn&rsquo;t grant page access by itself.</p>
          <h3>&ldquo;Chrome does not allow guidance on this page&rdquo;</h3>
          <p>
            You are on a restricted surface — <code>chrome://</code> pages and the Chrome Web Store
            can&rsquo;t be shared. Switch to a normal website.
          </p>
          <h3>Microphone denied</h3>
          <p>
            Press the voice beacon and choose <strong>Enable microphone</strong> — the wizard
            reopens on the microphone step with the exact Chrome settings address. If Chrome never
            asks, also allow Google Chrome the microphone in System Settings &rsaquo; Privacy &amp;
            Security.
          </p>
          <h3>&ldquo;OpenAI Realtime rejected the session request&rdquo;</h3>
          <p>
            Usually a revoked or unfunded API key. Issue a fresh key at the OpenAI Platform and
            re-save it from the wizard — the key form clears and replaces the Keychain entry.
          </p>
          <h3>Helper not answering</h3>
          <p>
            Run <code>npm run install:helper</code> again, or open{" "}
            <strong>Browser Guide Helper.app</strong> and choose Repair. Then use{" "}
            <strong>Check again</strong> in the wizard.
          </p>
        </section>
      </main>

      <footer className="footer">
        <span>
          <i aria-hidden="true" />
          Crawlio Browser Guide — reads, explains, points. Never acts.
        </span>
        <span>
          <a href="https://github.com/Crawlio-app/browser-guide">Open source</a>
          {" · by "}
          <a href="https://www.crawlio.app">Crawlio</a>
          {" · macOS 13+ · Chrome 116+"}
        </span>
      </footer>
    </div>
  );
}
