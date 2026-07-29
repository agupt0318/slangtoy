// slangtoy entry point. Boots the UI shell; the GPU host and Slang compiler
// arrive in later commits.

const statusEl = document.querySelector<HTMLElement>('#status')!;

export function setStatus(text: string, state?: 'ok' | 'error'): void {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

setStatus('shell ready');
