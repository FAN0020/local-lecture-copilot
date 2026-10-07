function revisionTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? null : parsed;
}

export class SessionTitleDraft {
  constructor() {
    this.requestSequence = 0;
    this.generation = 0;
    this.clear();
  }

  clear() {
    this.generation += 1;
    this.sessionId = null;
    this.canonicalTitle = '';
    this.canonicalRevision = null;
    this.draftTitle = '';
    this.editRevision = 0;
    this.editing = false;
    this.saving = false;
    this.error = null;
    this.latestRequestId = 0;
    this.pendingEditRevision = null;
    this.pendingDraftTitle = null;
  }

  select(session) {
    this.generation += 1;
    this.sessionId = session.id;
    this.canonicalTitle = String(session.title || '');
    this.canonicalRevision = revisionTime(session.updatedAt);
    this.draftTitle = this.canonicalTitle;
    this.editRevision = 0;
    this.editing = false;
    this.saving = false;
    this.error = null;
    this.latestRequestId = 0;
    this.pendingEditRevision = null;
    this.pendingDraftTitle = null;
  }

  sync(session) {
    if (!session) {
      if (this.sessionId) this.clear();
      return false;
    }
    if (session.id !== this.sessionId) {
      this.select(session);
      return true;
    }

    const incomingRevision = revisionTime(session.updatedAt);
    const currentRevision = this.canonicalRevision;
    const incomingTitle = String(session.title || '');
    const isCurrent = incomingRevision === null
      || currentRevision === null
      || incomingRevision > currentRevision
      || (incomingRevision === currentRevision && incomingTitle === this.canonicalTitle);
    if (!isCurrent) return false;

    this.canonicalTitle = incomingTitle;
    this.canonicalRevision = incomingRevision;
    if (!this.editing) this.draftTitle = this.canonicalTitle;
    return true;
  }

  beginEditing() {
    if (!this.sessionId || this.editing) return;
    this.draftTitle = this.canonicalTitle;
    this.editing = true;
  }

  update(value) {
    if (!this.sessionId) return;
    this.beginEditing();
    this.draftTitle = String(value);
    this.editRevision += 1;
    this.error = null;
  }

  prepareSave() {
    if (!this.sessionId || !this.editing) return null;
    if (this.saving
      && this.pendingEditRevision === this.editRevision
      && this.pendingDraftTitle === this.draftTitle) return null;
    if (!this.saving && this.draftTitle.trim() === this.canonicalTitle) {
      this.draftTitle = this.canonicalTitle;
      this.editing = false;
      this.saving = false;
      this.error = null;
      return null;
    }

    const request = {
      generation: this.generation,
      id: ++this.requestSequence,
      sessionId: this.sessionId,
      draftTitle: this.draftTitle,
      editRevision: this.editRevision,
    };
    this.latestRequestId = request.id;
    this.saving = true;
    this.error = null;
    this.pendingEditRevision = request.editRevision;
    this.pendingDraftTitle = request.draftTitle;
    return request;
  }

  requestIsCurrent(request) {
    return request.generation === this.generation
      && request.sessionId === this.sessionId
      && request.id === this.latestRequestId;
  }

  requestWasSuperseded(request) {
    return request.generation === this.generation
      && request.sessionId === this.sessionId
      && request.id < this.latestRequestId;
  }

  acceptSave(request, session) {
    if (!this.requestIsCurrent(request)) return false;
    this.canonicalTitle = String(session.title || '');
    this.canonicalRevision = revisionTime(session.updatedAt);
    this.saving = false;
    this.error = null;
    this.pendingEditRevision = null;
    this.pendingDraftTitle = null;
    if (this.editRevision === request.editRevision && this.draftTitle === request.draftTitle) {
      this.draftTitle = this.canonicalTitle;
      this.editing = false;
    }
    return true;
  }

  rejectSave(request, error) {
    if (!this.requestIsCurrent(request)) return false;
    this.saving = false;
    this.editing = true;
    this.error = error;
    this.pendingEditRevision = null;
    this.pendingDraftTitle = null;
    return true;
  }

  get value() {
    return this.editing ? this.draftTitle : this.canonicalTitle;
  }

  titleFor(session) {
    return session?.id === this.sessionId ? this.canonicalTitle : String(session?.title || '');
  }
}

export function bindSessionTitleInput(input, { onFocus, onInput, onCommit }) {
  input.addEventListener('focus', onFocus);
  input.addEventListener('input', (event) => onInput(event.target.value));
  input.addEventListener('blur', () => { void onCommit(); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.blur();
  });
}
