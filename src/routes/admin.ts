import { requireAdmin } from '../domain/access.ts';
import { appointOrganizer, issueResetLink, listUsers, setAdmin } from '../domain/admin.ts';
import { listEvents } from '../domain/events.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { ValidationError } from '../util/errors.ts';
import { adminPage, type AdminView } from '../views/admin.ts';

export const adminRoutes: RouteModule = (router, { store, config }) => {
  const render = (ctx: Ctx, extra: Partial<AdminView> = {}, status = 200) => {
    const q = ctx.query('q') ?? '';
    ctx.html(adminPage(ctx, { users: listUsers(store, ctx.actor, q), events: listEvents(store), q, ...extra }), status);
  };

  router.get('/admin', (ctx) => {
    requireAdmin(ctx.actor);
    render(ctx);
  });

  router.post('/admin/users/:id/link', (ctx) => {
    const { user, token } = issueResetLink(store, ctx.actor, ctx.params.id as string);
    const url = `${config.publicUrl}/password/${token}`;
    if (ctx.wantsJson) return ctx.json({ url });
    render(ctx, { resetLink: { email: user.email, url } });
  });

  router.post('/admin/users/:id/admin', async (ctx) => {
    const body = await ctx.body();
    setAdmin(store, ctx.actor, ctx.params.id as string, body.admin === '1');
    ctx.flash('success', 'Administrator access updated.');
    ctx.redirect('/admin');
  });

  router.post('/admin/organizers', async (ctx) => {
    const body = await ctx.body();
    try {
      appointOrganizer(store, ctx.actor, typeof body.event_id === 'string' ? body.event_id : '', typeof body.email === 'string' ? body.email : '');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return render(ctx, { errors: error.fields }, 422);
    }
    ctx.flash('success', 'Organizer appointed.');
    ctx.redirect('/admin');
  });
};
