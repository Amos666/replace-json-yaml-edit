# Third-Party Notices

This extension bundles the following third-party packages into `dist/extension.js`
and ships the Codicon font/CSS in `dist/ui/`. All are pure JavaScript / static
assets with zero runtime dependencies and no native modules. The build
(`esbuild --legal-comments=linked`) additionally extracts in-source legal
comments to `dist/extension.js.LEGAL.txt`.

Full license texts that are too long to inline are shipped alongside this file
under `licenses/` and are included in the `.vsix`.

## jsonc-parser 3.3.1 — MIT

Copyright (c) Microsoft Corporation.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## yaml 2.9.1 — ISC

Copyright (c) 2018, Eemeli Aro <eemeli@gmail.com>

```
ISC License

Copyright (c) 2018, Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

## @vscode/codicons — CC BY 4.0 (icons) / MIT (code)

The Codicon icon font (`dist/ui/codicon.ttf`) and its CSS
(`dist/ui/codicon.css`) are derived from Microsoft's
**@vscode/codicons** project (Copyright Microsoft Corporation).

- **Icons / font / CSS: Creative Commons Attribution 4.0 International (CC BY 4.0).**
  Full license text: `licenses/codicons-LICENSE.txt` (shipped in the `.vsix`).
  Attribution: Codicon icons by Microsoft Corporation, used under CC BY 4.0;
  this notice and the shipped license text constitute the required attribution.
- **Build scripts / source code: MIT.** Full license text:
  `licenses/codicons-LICENSE-CODE.txt` (shipped in the `.vsix`).

`@vscode/codicons` is a devDependency used only at build time to copy the font
and CSS into `dist/ui/`; no runtime dependency on the package remains.
