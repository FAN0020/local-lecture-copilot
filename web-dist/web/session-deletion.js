import { t } from './i18n.js';

const MENU_MARGIN = 8;

export function deletionConfirmationCopy(session) {
  const title = String(session?.title || t('session.untitled'));
  return {
    heading: t('dialog.deleteHeading', { title }),
    description: t('dialog.deleteDescription'),
  };
}

export function selectedSessionAfterDeletion(sessions, deletedId, selectedId) {
  if (selectedId !== deletedId) return selectedId || null;
  const index = sessions.findIndex((session) => session.id === deletedId);
  if (index < 0) return null;
  return sessions[index + 1]?.id || sessions[index - 1]?.id || null;
}

export function openSessionContextMenu({ event, menu, sessionId, viewport = globalThis }) {
  event.preventDefault();
  const width = menu.offsetWidth || 176;
  const height = menu.offsetHeight || 42;
  const maxLeft = Math.max(MENU_MARGIN, viewport.innerWidth - width - MENU_MARGIN);
  const maxTop = Math.max(MENU_MARGIN, viewport.innerHeight - height - MENU_MARGIN);
  menu.style.left = `${Math.max(MENU_MARGIN, Math.min(event.clientX, maxLeft))}px`;
  menu.style.top = `${Math.max(MENU_MARGIN, Math.min(event.clientY, maxTop))}px`;
  menu.dataset.sessionId = sessionId;
  menu.classList.remove('hidden');
  menu.querySelector('[role="menuitem"]')?.focus();
}

export function closeSessionContextMenu(menu) {
  menu.classList.add('hidden');
  delete menu.dataset.sessionId;
}

export async function confirmAndDeleteSession({ session, sessions, selectedId, confirmDelete, remove }) {
  if (!await confirmDelete(session)) {
    return { status: 'cancelled', sessions, selectedId: selectedId || null };
  }
  await remove(session.id);
  return {
    status: 'deleted',
    sessions: sessions.filter((item) => item.id !== session.id),
    selectedId: selectedSessionAfterDeletion(sessions, session.id, selectedId),
  };
}
