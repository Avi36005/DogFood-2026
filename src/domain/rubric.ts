import type { Store } from '../db/store.ts';
import { FormReader, slugify, type Body } from '../util/form.ts';
import { newId } from '../util/tokens.ts';
import { iso } from '../util/time.ts';
import { requireOrganizer } from './access.ts';
import { record } from './audit.ts';
import { listCriteria } from './events.ts';
import type { Actor, EventRow } from './types.ts';

/**
 * Once any score exists, the set of criteria and the scale are fixed: changing them would make
 * earlier reviews incomparable with later ones. Weights stay editable, because raw criterion
 * scores are stored and the weighted score is recomputed; every weight change is audited and
 * a published snapshot keeps the weights it used.
 */
export function rubricLocked(store: Store, eventId: string): boolean {
  return store.get('SELECT 1 FROM review_scores s JOIN criteria c ON c.id = s.criterion_id WHERE c.event_id = ? LIMIT 1', [eventId]) !== undefined;
}

export function saveRubric(store: Store, actor: Actor, event: EventRow, body: Body): void {
  requireOrganizer(store, actor, event, `change the rubric of ${event.name}`);
  const form = new FormReader(body);
  const locked = rubricLocked(store, event.id);
  const existing = listCriteria(store, event.id);

  const updates = existing.map((c) => ({
    before: c,
    name: form.text(`name_${c.id}`, { label: `${c.name}: name`, required: true, max: 80 }),
    description: form.text(`description_${c.id}`, { label: `${c.name}: description`, max: 500 }),
    weight: form.number(`weight_${c.id}`, { label: `${c.name}: weight`, min: 0.1, max: 100 }),
    remove: form.checked(`remove_${c.id}`),
  }));
  const newName = form.text('new_name', { label: 'New criterion name', max: 80 });
  const added = newName
    ? { name: newName, description: form.text('new_description', { label: 'New criterion description', max: 500 }), weight: form.number('new_weight', { label: 'New criterion weight', min: 0.1, max: 100 }) }
    : null;
  const scaleMin = form.int('score_min', { label: 'Lowest score', min: 0, max: 10, fallback: event.score_min });
  const scaleMax = form.int('score_max', { label: 'Highest score', min: 1, max: 100, fallback: event.score_max });
  if (scaleMin >= scaleMax) form.fail('score_max', 'The highest score must be above the lowest.');

  if (locked) {
    if (updates.some((u) => u.remove) || added) form.fail('locked', 'Scoring has started, so criteria can no longer be added or removed. Weights, names and descriptions can still change.');
    if (scaleMin !== event.score_min || scaleMax !== event.score_max) form.fail('score_max', 'Scoring has started, so the scale is fixed.');
  }
  if (updates.filter((u) => !u.remove).length + (added ? 1 : 0) === 0) form.fail('locked', 'Keep at least one criterion.');
  const key = added ? slugify(added.name).replaceAll('-', '_') || 'criterion' : null;
  if (key && existing.some((c) => c.key === key)) form.fail('new_name', 'A criterion with this name already exists.');
  form.assertValid();

  store.tx(() => {
    const changes: string[] = [];
    for (const u of updates) {
      if (u.remove) {
        store.run('DELETE FROM criteria WHERE id = ?', [u.before.id]);
        changes.push(`removed ${u.before.name}`);
        continue;
      }
      if (u.name !== u.before.name || u.description !== u.before.description || u.weight !== u.before.weight) {
        store.run('UPDATE criteria SET name = ?, description = ?, weight = ? WHERE id = ?', [u.name, u.description, u.weight, u.before.id]);
        if (u.weight !== u.before.weight) changes.push(`${u.name} weight ${u.before.weight} → ${u.weight}`);
        if (u.name !== u.before.name) changes.push(`renamed ${u.before.name} to ${u.name}`);
        if (u.description !== u.before.description && u.name === u.before.name) changes.push(`described ${u.name}`);
      }
    }
    if (added && key) {
      store.run('INSERT INTO criteria (id, event_id, key, name, description, weight, position) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        newId('crt'), event.id, key, added.name, added.description, added.weight, existing.length,
      ]);
      changes.push(`added ${added.name} (weight ${added.weight})`);
    }
    if (scaleMin !== event.score_min || scaleMax !== event.score_max) {
      store.run('UPDATE events SET score_min = ?, score_max = ?, updated_at = ? WHERE id = ?', [scaleMin, scaleMax, iso(actor.now), event.id]);
      changes.push(`scale ${event.score_min}–${event.score_max} → ${scaleMin}–${scaleMax}`);
    }
    if (changes.length === 0) return;
    record(store, actor, { eventId: event.id, action: 'rubric.changed', subjectType: 'event', subjectId: event.id, summary: `Changed the rubric: ${changes.join('; ')}.` });
  });
}
