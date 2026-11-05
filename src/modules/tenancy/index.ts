// Public API of the tenancy module. Other modules import only from here.
// Read paths and organization bootstrap only for now: membership and role mutations arrive with the
// audit log in Sprint 2 so that every grant is recorded in the same transaction (CLAUDE.md rule 3).
export { createOrganization, listTeams, listUserOrganizations } from "./organizations";
