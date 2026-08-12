# Security Policy

## Reporting a vulnerability

Please email **rashid.azarang.eg@gmail.com** with the details. Do not open a public issue for security reports. You should receive a response within a few days.

Reports we especially care about:

- Any way for the extension to act on a page: synthetic clicks, typing, focus, navigation, scrolling outside the documented take-me-there arrow, or form mutation.
- Any path that exposes the OpenAI API key outside macOS Keychain (Chrome storage, logs, argv, network requests other than the authenticated call to OpenAI).
- Escapes of the sanitization boundary: input values, passwords, cookies, or hidden form data reaching the model.
- Screenshot fail-closed bypasses: a capture succeeding while sensitive content is visible.
- Native messaging host impersonation or unauthorized extension origins reaching the helper.

## Threat model notes

- The helper builds ad-hoc signed from source. macOS Keychain access control for ad-hoc binaries is hash-based; a locally built helper owns its own item. Local malware running as your user is outside the threat model this project can defend against — a notarized Developer ID distribution is planned.
- Page content is treated as untrusted evidence everywhere, including in the model instructions; prompt-injection reports that cause the model to *act* are in scope by definition of the read-only boundary (there is no acting tool to hijack), but reports that degrade guidance quality are still welcome.
