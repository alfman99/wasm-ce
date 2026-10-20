/**
 * Navigation for the panel: the command palette, the theme switch, the "Now" breadcrumb and the
 * help sheet.
 *
 * None of this talks to the bridge. It only moves focus, remembers a theme choice, and describes
 * state the panel already renders, so it cannot become a way around the approval gate.
 */

const THEME_KEY = 'panelTheme';

interface Card {
  id: string;
  title: string;
  hint: string;
}

function cardList(): Card[] {
  const cards: Card[] = [];
  for (const group of document.querySelectorAll<HTMLFieldSetElement>('fieldset.group[id]')) {
    const legend = group.querySelector('legend');
    const hint = group.querySelector('.hint');
    cards.push({
      id: group.id,
      title: legend?.textContent?.trim() ?? group.id,
      hint: hint?.textContent?.trim() ?? '',
    });
  }
  return cards;
}

/** The field a human would type into first, which is what "go to this card" should focus. */
function firstControl(id: string): HTMLElement | null {
  const group = document.getElementById(id);
  if (!group) return null;
  return group.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button');
}

function jumpTo(id: string): void {
  const group = document.getElementById(id);
  if (!group) return;
  group.scrollIntoView({ block: 'start', behavior: 'smooth' });
  // :target styles the card while the hash points at it, which is the highlight; no flash class.
  if (id !== '') window.location.hash = `#${id}`;
  const control = firstControl(id);
  if (control && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
    control.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- theme

function applyTheme(theme: string | undefined): void {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/**
 * Light is the default on purpose: this is a diagnostic surface used next to a bright page, and a
 * dark panel that only follows the OS throws the choice away. The toggle remembers what you picked.
 */
function currentTheme(): 'light' | 'dark' {
  const stored = document.documentElement.dataset.theme;
  return stored === 'dark' ? 'dark' : 'light';
}

function toggleTheme(): void {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  void chrome.storage.local.set({ [THEME_KEY]: next });
}

// ---------------------------------------------------------------- palette

function installPalette(): void {
  const overlay = document.getElementById('palette');
  const input = document.getElementById('palette-input') as HTMLInputElement | null;
  const list = document.getElementById('palette-list');
  if (!overlay || !input || !list) return;

  const cards = cardList();
  let filtered = cards;
  let active = 0;

  function render(): void {
    const needle = input?.value.trim().toLowerCase() ?? '';
    filtered = cards.filter(
      (card) => needle === '' || `${card.title} ${card.hint}`.toLowerCase().includes(needle),
    );
    active = Math.min(active, Math.max(filtered.length - 1, 0));
    list?.replaceChildren();
    filtered.forEach((card, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === active));
      const title = document.createElement('span');
      title.textContent = card.title;
      const where = document.createElement('span');
      where.className = 'palette__where';
      where.textContent = card.id;
      item.append(title, where);
      item.addEventListener('click', () => {
        close();
        jumpTo(card.id);
      });
      list?.append(item);
    });
    if (filtered.length === 0) {
      const item = document.createElement('li');
      item.textContent = 'No card matches that. Try "scan", "freeze" or "audit".';
      list?.append(item);
    }
  }

  function open(): void {
    overlay?.removeAttribute('hidden');
    if (input) {
      input.value = '';
      input.focus();
    }
    active = 0;
    render();
  }

  function close(): void {
    overlay?.setAttribute('hidden', '');
  }

  function visible(): boolean {
    return overlay?.hasAttribute('hidden') === false;
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = filtered[active];
      if (chosen) {
        close();
        jumpTo(chosen.id);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  document.addEventListener('keydown', (event) => {
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (visible()) close();
      else open();
      return;
    }
    if (event.key === 'Escape' && visible()) {
      close();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '?') {
      event.preventDefault();
      toggleHelp();
    } else if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      toggleTheme();
    }
  });

  document.getElementById('palette-open')?.addEventListener('click', open);
}

// ---------------------------------------------------------------- help

function toggleHelp(): void {
  const sheet = document.getElementById('help');
  if (!sheet) return;
  if (sheet.hasAttribute('hidden')) sheet.removeAttribute('hidden');
  else sheet.setAttribute('hidden', '');
  if (!sheet.hasAttribute('hidden')) document.getElementById('help-close')?.focus();
}

function installHelp(): void {
  document.getElementById('help-open')?.addEventListener('click', toggleHelp);
  document.getElementById('help-close')?.addEventListener('click', toggleHelp);
  document.getElementById('help')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.id === 'help') toggleHelp();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      document.getElementById('help')?.setAttribute('hidden', '');
    }
  });
}

// ---------------------------------------------------------------- crumbs

function crumbText(): { title: string; instance: string; address: string } {
  const target = document.getElementById('target')?.textContent?.trim() ?? '';
  const instance = (document.getElementById('scan-instance') as HTMLInputElement | null)?.value ?? '';
  const address = (document.getElementById('mem-address') as HTMLInputElement | null)?.value ?? '';
  // "Foundry — demo target · http://…" -> "Foundry": the crumb names the page you are looking at,
  // not the URL you already know.
  const name = target.replace(/^tab \d+ · /, '').split(' · ')[0]?.trim() ?? '';
  const title = name.length > 42 ? `${name.slice(0, 41)}…` : name;
  return { title, instance: instance.trim(), address: address.trim() };
}

function renderCrumbs(): void {
  const host = document.getElementById('crumbs');
  if (!host) return;
  const { title, instance, address } = crumbText();
  const parts: (string | HTMLElement)[] = [];
  const add = (value: string, tag?: 'b' | 'i'): void => {
    if (value === '') return;
    if (parts.length > 0) parts.push(Object.assign(document.createElement('i'), { textContent: ' · ' }));
    const node = document.createElement(tag ?? 'span');
    node.textContent = value;
    parts.push(node);
  };
  add(title || 'no tab attached', title ? 'b' : undefined);
  add(instance);
  add(address);
  host.replaceChildren(...parts);
}

function installCrumbs(): void {
  renderCrumbs();
  const observer = new MutationObserver(renderCrumbs);
  for (const id of ['target', 'scan-id', 'scan-hits', 'instances-out']) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { childList: true, characterData: true, subtree: true });
  }
  document.addEventListener('input', renderCrumbs, true);
  // Buttons fill fields programmatically, which fires no input event; the next task is soon enough.
  document.addEventListener(
    'click',
    () => {
      window.setTimeout(renderCrumbs, 0);
    },
    true,
  );
}

export function installPanelHelp(): void {
  void chrome.storage.local.get(THEME_KEY).then((stored) => {
    const value = stored[THEME_KEY];
    if (typeof value === 'string') applyTheme(value);
  });
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  installPalette();
  installHelp();
  installCrumbs();
}
