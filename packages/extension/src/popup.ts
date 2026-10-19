import type { ApprovalState, TabInfo } from '@wasmcheat/protocol';

interface PopupState {
  approvals: Record<string, { state: ApprovalState; reason: string; at: number }>;
  tabs: TabInfo[];
  bridgeConnected: boolean;
}

const tabsList = document.getElementById('tabs') as HTMLUListElement;
const bridgePill = document.getElementById('bridge') as HTMLSpanElement;
const hint = document.getElementById('hint') as HTMLSpanElement;
const refresh = document.getElementById('refresh') as HTMLButtonElement;

function send<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function describeState(state: ApprovalState): string {
  switch (state) {
    case 'pending':
      return 'needs approval';
    case 'granted':
      return 'approved';
    case 'revoked':
      return 'revoked';
    default:
      return 'not approved';
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', async () => {
    element.disabled = true;
    try {
      await onClick();
      await render();
    } finally {
      element.disabled = false;
    }
  });
  return element;
}

function renderTab(tab: TabInfo): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'tab';
  item.dataset.state = tab.approval;
  item.dataset.tabId = String(tab.tabId);

  const title = document.createElement('span');
  title.className = 'tab__title';
  title.textContent = tab.title || '(untitled tab)';
  title.title = tab.title;

  const state = document.createElement('span');
  state.className = 'tab__state';
  state.textContent = describeState(tab.approval);

  const url = document.createElement('span');
  url.className = 'tab__url';
  url.textContent = tab.url;

  const actions = document.createElement('div');
  actions.className = 'tab__actions';

  if (tab.approval === 'pending') {
    actions.append(
      button('Approve', 'primary', () => send({ type: 'popup.approve', tabId: tab.tabId })),
      button('Deny', 'danger', () => send({ type: 'popup.deny', tabId: tab.tabId })),
    );
  } else if (tab.approval === 'granted') {
    actions.append(button('Revoke', 'danger', () => send({ type: 'popup.deny', tabId: tab.tabId })));
  } else {
    actions.append(
      button('Approve', 'primary', () => send({ type: 'popup.approve', tabId: tab.tabId })),
      button('Reload & attach', 'ghost', async () => {
        await send({ type: 'popup.approve', tabId: tab.tabId });
        await chrome.tabs.reload(tab.tabId);
      }),
    );
  }

  item.append(title, state, url, actions);
  return item;
}

async function render(): Promise<void> {
  const state = await send<PopupState>({ type: 'popup.state' });
  bridgePill.textContent = state.bridgeConnected ? 'bridge connected' : 'bridge offline';
  bridgePill.className = `pill ${state.bridgeConnected ? 'pill--live' : 'pill--idle'}`;

  tabsList.replaceChildren();
  if (state.tabs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No http(s) tabs open. Open the page you want to inspect first.';
    tabsList.append(empty);
  } else {
    for (const tab of state.tabs) tabsList.append(renderTab(tab));
  }

  const pending = state.tabs.filter((tab) => tab.approval === 'pending').length;
  const granted = state.tabs.filter((tab) => tab.approval === 'granted').length;
  hint.textContent =
    pending > 0
      ? `${pending} request${pending === 1 ? '' : 's'} waiting for you`
      : granted > 0
        ? `${granted} tab${granted === 1 ? '' : 's'} approved`
        : state.bridgeConnected
          ? 'Bridge is up. Nothing is approved yet.'
          : 'Start the MCP server to connect the bridge.';
}

refresh.addEventListener('click', () => void render());
void render();
setInterval(() => void render(), 2000);
