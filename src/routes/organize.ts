import { myEventRoles, requireOrganizer } from '../domain/access.ts';
import { auditActions, listAudit } from '../domain/audit.ts';
import { addOrganizer, addPrize, addTrack, closeSubmissionsNow, getEvent, listCriteria, listOrganizers, listPrizes, listTracks, removePrize, removeTrack, updateEvent } from '../domain/events.ts';
import { assignManually, autoAssign, inviteJudge, listAssignments, listJudges, removeJudge, setJudgeTracks, unassign } from '../domain/judging.ts';
import { eventProgress } from '../domain/progress.ts';
import { chooseLiveSubmission, duplicateGroups, eventProjects } from '../domain/projects.ts';
import { computeStandings, listSnapshots, publishResults, unpublishResults } from '../domain/results.ts';
import { rubricLocked, saveRubric } from '../domain/rubric.ts';
import type { EventRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { unauthorized, ValidationError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { assignmentsPage, auditPage, exportPage, judgesPage, organizeHomePage, overviewPage, progressFragment, projectsAdminPage, resultsAdminPage, rubricPage, settingsPage, type OverviewView } from '../views/organize.ts';

