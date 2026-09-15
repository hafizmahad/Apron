import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userRoles, type UserRole } from '@/db/schema/enums';
import {
  can,
  canActOnOffer,
  canApproveProvider,
  canAssignResources,
  canViewPassengerContacts,
  canViewRequest,
  homePortal,
  isScopedToClient,
  isScopedToProvider,
  permissions,
  permissionsFor,
  requiresReason,
  REASON_REQUIRED_ACTIONS,
  type Actor,
  type Permission,
} from '@/domain/permissions';

/**
 * RBAC and tenant isolation (CLAUDE.md §5, §32 Journey G).
 *
 * The matrix is asserted exhaustively rather than by example: every role is checked
 * against every permission, so a capability accidentally granted to a role shows up as a
 * failing test rather than as a security hole someone finds later.
 */

function actor(role: UserRole, overrides: Partial<Actor> = {}): Actor {
  const providerRoles: UserRole[] = ['provider_admin', 'provider_dispatcher', 'provider_staff'];
  return {
    userId: `user-${role}`,
    role,
    providerCompanyId: providerRoles.includes(role) ? 'provider-a' : null,
    clientOrganizationId: role === 'client' ? 'client-a' : null,
    status: 'active',
    ...overrides,
  };
}

describe('the matrix is exhaustive and self-consistent', () => {
  it('every role has an entry', () => {
    for (const role of userRoles) {
      expect(() => permissionsFor(role)).not.toThrow();
    }
  });

  it('every granted permission is a declared permission', () => {
    const declared = new Set<string>(permissions);
    for (const role of userRoles) {
      for (const permission of permissionsFor(role)) {
        expect(declared.has(permission)).toBe(true);
      }
    }
  });

  it('platform_admin holds every permission', () => {
    expect(permissionsFor('platform_admin').sort()).toEqual([...permissions].sort());
  });

  it('no permission is unreachable — every one is held by at least one role', () => {
    const granted = new Set<string>();
    for (const role of userRoles) {
      for (const permission of permissionsFor(role)) granted.add(permission);
    }
    const orphans = permissions.filter((permission) => !granted.has(permission));
    expect(orphans).toEqual([]);
  });
});

describe('operations cannot perform platform governance', () => {
  const governance: Permission[] = [
    'provider.approve',
    'provider.suspend',
    'provider.set_rank',
    'catalogue.manage',
    'registry.manage',
    'user.manage',
    'settings.manage',
    'feature_flag.manage',
    'ai.view_observability',
  ];

  it.each(governance)('operations_manager cannot %s', (permission) => {
    expect(can(actor('operations_manager'), permission)).toBe(false);
  });

  it.each(governance)('operations_agent cannot %s', (permission) => {
    expect(can(actor('operations_agent'), permission)).toBe(false);
  });

  it('platform_admin can', () => {
    for (const permission of governance) {
      expect(can(actor('platform_admin'), permission)).toBe(true);
    }
  });
});

describe('operations seniority', () => {
  const managerOnly: Permission[] = [
    'request.cancel',
    'request.override_provider',
    'request.force_status',
    'request.release_contacts_to_provider',
    'assignment.create',
    'assignment.release',
  ];

  it.each(managerOnly)('an agent cannot %s', (permission) => {
    expect(can(actor('operations_agent'), permission)).toBe(false);
  });

  it.each(managerOnly)('a manager can %s', (permission) => {
    expect(can(actor('operations_manager'), permission)).toBe(true);
  });

  it('both can view every request and its decision trace', () => {
    for (const role of ['operations_agent', 'operations_manager'] as const) {
      expect(can(actor(role), 'request.view.any')).toBe(true);
      expect(can(actor(role), 'request.view_decision_trace')).toBe(true);
    }
  });
});

describe('providers cannot reach platform or operations capabilities', () => {
  const providerRoles: UserRole[] = ['provider_admin', 'provider_dispatcher', 'provider_staff'];
  const forbidden: Permission[] = [
    'request.view.any',
    'request.create',
    'request.cancel',
    'request.override_provider',
    'request.view_decision_trace',
    'request.use_research_assistant',
    'provider.view.any',
    'provider.approve',
    'provider.suspend',
    'provider.set_rank',
    'catalogue.manage',
    'registry.manage',
    'user.manage',
    'settings.manage',
    'audit.view',
    'ai.view_observability',
    'message.send.internal',
    'message.view.any',
    'assignment.view.any',
  ];

  for (const role of providerRoles) {
    it.each(forbidden)(`${role} cannot %s`, (permission) => {
      expect(can(actor(role), permission)).toBe(false);
    });
  }

  it('no provider role can approve any provider — not even another one', () => {
    for (const role of providerRoles) {
      expect(can(actor(role), 'provider.approve')).toBe(false);
      expect(canApproveProvider(actor(role), 'provider-b')).toBe(false);
    }
  });

  it('an admin cannot approve their own company even if one is attached', () => {
    const conflicted = actor('platform_admin', { providerCompanyId: 'provider-a' });
    expect(canApproveProvider(conflicted, 'provider-a')).toBe(false);
    expect(canApproveProvider(conflicted, 'provider-b')).toBe(true);
  });
});

describe('provider_staff is read-and-assign only', () => {
  it('cannot acknowledge or decline an offer', () => {
    expect(can(actor('provider_staff'), 'offer.acknowledge')).toBe(false);
    expect(can(actor('provider_staff'), 'offer.decline')).toBe(false);
  });

  it('cannot manage the company profile, coverage or users', () => {
    expect(can(actor('provider_staff'), 'provider.manage.own_profile')).toBe(false);
    expect(can(actor('provider_staff'), 'provider.manage.own_coverage')).toBe(false);
    expect(can(actor('provider_staff'), 'provider.manage.own_users')).toBe(false);
  });

  it('can still see their company and its work', () => {
    expect(can(actor('provider_staff'), 'provider.view.own')).toBe(true);
    expect(can(actor('provider_staff'), 'assignment.view.own_provider')).toBe(true);
  });

  it('only provider_admin may manage company users', () => {
    expect(can(actor('provider_admin'), 'provider.manage.own_users')).toBe(true);
    expect(can(actor('provider_dispatcher'), 'provider.manage.own_users')).toBe(false);
  });
});

describe('clients see only their own requests', () => {
  const forbidden: Permission[] = [
    'request.view.any',
    'request.view_decision_trace',
    'request.use_research_assistant',
    'provider.view.any',
    'provider.view.own',
    'assignment.view.any',
    'offer.acknowledge',
    'audit.view',
    'message.send.internal',
  ];

  it.each(forbidden)('a client cannot %s', (permission) => {
    expect(can(actor('client'), permission)).toBe(false);
  });

  it('a client can create and view their own requests', () => {
    expect(can(actor('client'), 'request.create')).toBe(true);
    expect(can(actor('client'), 'request.view.own_client')).toBe(true);
  });
});

describe('suspended and invited accounts hold no permissions at all', () => {
  it.each(userRoles)('a suspended %s holds nothing', (role) => {
    const suspended = actor(role, { status: 'suspended' });
    for (const permission of permissions) {
      expect(can(suspended, permission)).toBe(false);
    }
  });

  it.each(userRoles)('an invited %s holds nothing', (role) => {
    const invited = actor(role, { status: 'invited' });
    for (const permission of permissions) {
      expect(can(invited, permission)).toBe(false);
    }
  });

  it('a suspended admin cannot reach any tenant either', () => {
    const suspended = actor('platform_admin', { status: 'suspended' });
    expect(isScopedToProvider(suspended, 'provider-a')).toBe(false);
    expect(isScopedToClient(suspended, 'client-a')).toBe(false);
  });
});

describe('tenant isolation — Journey G', () => {
  it('a provider dispatcher reaches only their own company', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(isScopedToProvider(dispatcher, 'provider-a')).toBe(true);
    expect(isScopedToProvider(dispatcher, 'provider-b')).toBe(false);
  });

  it('every provider role is confined the same way', () => {
    for (const role of ['provider_admin', 'provider_dispatcher', 'provider_staff'] as const) {
      const person = actor(role, { providerCompanyId: 'provider-a' });
      expect(isScopedToProvider(person, 'provider-b')).toBe(false);
    }
  });

  it('a client reaches only their own organisation', () => {
    const client = actor('client', { clientOrganizationId: 'client-a' });
    expect(isScopedToClient(client, 'client-a')).toBe(true);
    expect(isScopedToClient(client, 'client-b')).toBe(false);
  });

  it('a client cannot reach any provider company', () => {
    expect(isScopedToProvider(actor('client'), 'provider-a')).toBe(false);
  });

  it('a provider user cannot reach a client organisation', () => {
    expect(isScopedToClient(actor('provider_admin'), 'client-a')).toBe(false);
  });

  it('operations and admin span both tenant axes', () => {
    for (const role of ['platform_admin', 'operations_manager', 'operations_agent'] as const) {
      expect(isScopedToProvider(actor(role), 'provider-a')).toBe(true);
      expect(isScopedToProvider(actor(role), 'provider-b')).toBe(true);
      expect(isScopedToClient(actor(role), 'client-a')).toBe(true);
    }
  });
});

describe('request visibility', () => {
  const scope = {
    clientOrganizationId: 'client-a',
    involvedProviderCompanyIds: ['provider-a'],
  };

  it('operations and admin see any request', () => {
    for (const role of ['platform_admin', 'operations_manager', 'operations_agent'] as const) {
      expect(canViewRequest(actor(role), scope)).toBe(true);
    }
  });

  it('a client sees their own organisation’s request and no other', () => {
    expect(canViewRequest(actor('client', { clientOrganizationId: 'client-a' }), scope)).toBe(true);
    expect(canViewRequest(actor('client', { clientOrganizationId: 'client-b' }), scope)).toBe(false);
  });

  it('a provider sees a request only while their company is involved', () => {
    const involved = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    const uninvolved = actor('provider_dispatcher', { providerCompanyId: 'provider-b' });
    expect(canViewRequest(involved, scope)).toBe(true);
    expect(canViewRequest(uninvolved, scope)).toBe(false);
  });

  it('a provider loses visibility once their involvement ends', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(canViewRequest(dispatcher, { ...scope, involvedProviderCompanyIds: [] })).toBe(false);
  });
});

describe('passenger contact disclosure', () => {
  const base = {
    clientOrganizationId: 'client-a',
    involvedProviderCompanyIds: ['provider-a'],
    acknowledgedByProviderCompanyIds: [] as string[],
    contactsReleasedToProviderCompanyIds: [] as string[],
  };

  it('is concealed from a provider before acknowledgement', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(canViewPassengerContacts(dispatcher, base)).toBe(false);
  });

  it('is revealed to a provider once they have acknowledged', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(
      canViewPassengerContacts(dispatcher, {
        ...base,
        acknowledgedByProviderCompanyIds: ['provider-a'],
      }),
    ).toBe(true);
  });

  it('is revealed when operations releases it early', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(
      canViewPassengerContacts(dispatcher, {
        ...base,
        contactsReleasedToProviderCompanyIds: ['provider-a'],
      }),
    ).toBe(true);
  });

  it('another provider’s acknowledgement does not reveal it', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(
      canViewPassengerContacts(dispatcher, {
        ...base,
        involvedProviderCompanyIds: ['provider-a', 'provider-b'],
        acknowledgedByProviderCompanyIds: ['provider-b'],
      }),
    ).toBe(false);
  });

  it('an uninvolved provider never sees contacts, even if they somehow acknowledged', () => {
    const outsider = actor('provider_dispatcher', { providerCompanyId: 'provider-z' });
    expect(
      canViewPassengerContacts(outsider, {
        ...base,
        acknowledgedByProviderCompanyIds: ['provider-z'],
      }),
    ).toBe(false);
  });

  it('operations and admin always see contacts', () => {
    for (const role of ['platform_admin', 'operations_manager', 'operations_agent'] as const) {
      expect(canViewPassengerContacts(actor(role), base)).toBe(true);
    }
  });

  it('a client sees their own passengers', () => {
    expect(
      canViewPassengerContacts(actor('client', { clientOrganizationId: 'client-a' }), base),
    ).toBe(true);
    expect(
      canViewPassengerContacts(actor('client', { clientOrganizationId: 'client-b' }), base),
    ).toBe(false);
  });
});

describe('acting on an offer', () => {
  it('only the holding provider may acknowledge or decline', () => {
    const holder = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    const other = actor('provider_dispatcher', { providerCompanyId: 'provider-b' });

    expect(canActOnOffer(holder, 'acknowledge', 'provider-a')).toBe(true);
    expect(canActOnOffer(holder, 'decline', 'provider-a')).toBe(true);
    expect(canActOnOffer(other, 'acknowledge', 'provider-a')).toBe(false);
  });

  it('operations must not acknowledge on a provider’s behalf', () => {
    // Doing so would record a commitment the provider never actually made.
    expect(canActOnOffer(actor('operations_manager'), 'acknowledge', 'provider-a')).toBe(false);
    expect(canActOnOffer(actor('platform_admin'), 'acknowledge', 'provider-a')).toBe(false);
  });

  it('provider_staff cannot acknowledge', () => {
    const staff = actor('provider_staff', { providerCompanyId: 'provider-a' });
    expect(canActOnOffer(staff, 'acknowledge', 'provider-a')).toBe(false);
  });
});

describe('assigning resources', () => {
  it('a provider may assign only their own resources', () => {
    const dispatcher = actor('provider_dispatcher', { providerCompanyId: 'provider-a' });
    expect(canAssignResources(dispatcher, 'provider-a')).toBe(true);
    expect(canAssignResources(dispatcher, 'provider-b')).toBe(false);
  });

  it('an operations manager may assign on a provider’s behalf during an intervention', () => {
    expect(canAssignResources(actor('operations_manager'), 'provider-a')).toBe(true);
  });

  it('an operations agent may not', () => {
    expect(canAssignResources(actor('operations_agent'), 'provider-a')).toBe(false);
  });

  it('provider_staff may not assign', () => {
    const staff = actor('provider_staff', { providerCompanyId: 'provider-a' });
    expect(canAssignResources(staff, 'provider-a')).toBe(false);
  });
});

describe('portal routing', () => {
  it('sends each role to its own portal', () => {
    expect(homePortal(actor('platform_admin'))).toBe('/admin');
    expect(homePortal(actor('operations_manager'))).toBe('/ops');
    expect(homePortal(actor('operations_agent'))).toBe('/ops');
    expect(homePortal(actor('provider_admin'))).toBe('/provider');
    expect(homePortal(actor('provider_dispatcher'))).toBe('/provider');
    expect(homePortal(actor('provider_staff'))).toBe('/provider');
    expect(homePortal(actor('client'))).toBe('/client');
  });
});

describe('reason-required actions', () => {
  it('names the actions the services actually emit', () => {
    // These are the exact strings `recordAuditEvent` is called with. Asserting the list
    // against ITSELF is what let this drift: the old test passed while the pre-check never
    // fired, because it checked names no service ever writes.
    expect(requiresReason('request_line.override_provider')).toBe(true);
    expect(requiresReason('request_line.force_status')).toBe(true);
    expect(requiresReason('request.cancel')).toBe(true);
    expect(requiresReason('provider_company.suspend')).toBe(true);
    expect(requiresReason('provider_company.reject')).toBe(true);
    expect(requiresReason('assignment.force_release')).toBe(true);
    expect(requiresReason('user.suspend')).toBe(true);
  });

  it('does not demand one for ordinary actions', () => {
    expect(requiresReason('request.create')).toBe(false);
    expect(requiresReason('auth.login')).toBe(false);
  });

  it('matches the database constraint exactly', () => {
    // The database is the enforcement (CLAUDE.md §30). If these two ever disagree, the
    // application either rejects something the database allows, or — far worse — lets
    // something through that dies later as a raw constraint violation.
    const migration = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'src', 'db', 'migrations', '0002_identity_and_audit.sql'),
      'utf8',
    );

    const clause = /constraint audit_events_reason_required[\s\S]*?action not in \(([\s\S]*?)\)/.exec(migration);
    expect(clause, 'the reason-required constraint is gone from the migration').not.toBeNull();

    const inDatabase = [...(clause?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]);

    expect([...inDatabase].sort()).toEqual([...REASON_REQUIRED_ACTIONS].sort());
  });
});
