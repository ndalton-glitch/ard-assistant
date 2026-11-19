# ARD Assistant

Windows desktop app that drafts Texas ARD meeting summaries from IEPs, FIEs, MAP Growth and STAAR screenshots, and progress reports, using the Anthropic API.

**Download:** grab the latest `ARD Assistant Setup x.y.z.exe` from [Releases](../../releases) and double-click it.

Student files stay on your computer (Documents\ARD Assistant by default). Only the documents for a summary you ask it to read or draft are sent to the Anthropic API.

## Building
Pushing a tag like `v1.0.1` runs `.github/workflows/build-windows.yml`, which builds the installer on Windows and attaches it to a GitHub release.
