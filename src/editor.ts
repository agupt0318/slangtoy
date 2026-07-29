// CodeMirror 6 editor for Slang source. Slang is close enough to C++ that the
// cpp grammar gives usable highlighting; attributes like [shader("fragment")]
// are the only thing it reads oddly.

import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';

/** Diagnostics are pushed in from the compiler, so the linter just replays them. */
const diagnosticsCompartment = new Compartment();

function staticLinter(diagnostics: Diagnostic[]) {
  return linter(() => diagnostics, { delay: 0 });
}

export class Editor {
  private readonly view: EditorView;

  constructor(parent: HTMLElement, initialDoc: string, onChange: (doc: string) => void) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          basicSetup,
          cpp(),
          oneDark,
          lintGutter(),
          diagnosticsCompartment.of(staticLinter([])),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
          }),
        ],
      }),
    });
  }

  get doc(): string {
    return this.view.state.doc.toString();
  }

  setDoc(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  /** Converts 1-based (line, message) pairs into gutter markers and squiggles. */
  setDiagnostics(items: { line?: number; message: string; severity?: 'error' | 'warning' }[]): void {
    const doc = this.view.state.doc;
    const diagnostics: Diagnostic[] = items.map((item) => {
      const lineNo = Math.min(Math.max(item.line ?? 1, 1), doc.lines);
      const line = doc.line(lineNo);
      return {
        from: line.from,
        to: line.to,
        severity: item.severity ?? 'error',
        message: item.message,
      };
    });
    this.view.dispatch({
      effects: diagnosticsCompartment.reconfigure(staticLinter(diagnostics)),
    });
  }
}
