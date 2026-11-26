import { TEMPLATE_SCHEMA_VERSION, templateJsonSchemas, type TemplateDocumentInput, type TemplateIssueCode } from '@/lib/task-templates';

/**
 * What GET /api/v1/task-templates/schema answers: the JSON template as JSON
 * Schema (from the zod schema the server checks with), the error codes and
 * a worked example. docs/agents/templates.md walks through the same example.
 */

/** Every error code validate, create, update, preview and run answer with, in plain words. */
export const TEMPLATE_ERROR_CODES: Record<TemplateIssueCode, string> = {
  required: 'A property the template needs is missing.',
  unknown_property: 'A property the schema does not have. Remove it.',
  invalid_value: 'A value of the wrong type or form.',
  out_of_range: 'A list or text too long or too short.',
  offset_out_of_range: `due_in_days is more than 3650 days from its key date.`,
  duplicate_key: 'Two fields, key dates, roles or tasks share a key.',
  unknown_anchor: 'A task counts from a key date the template does not declare.',
  unknown_role: 'A task (or the run, or the initiative owner) names a role the template does not declare.',
  unknown_dependency: 'depends_on names a key no top-level task has.',
  dependency_not_top_level: 'depends_on names a subtask; tasks wait only on top-level tasks.',
  dependency_cycle: 'Tasks wait on each other in a loop; the error lists the loop in cycle.',
  undeclared_field: 'A {key} in a title or description has no field.',
  too_many_tasks: 'More than 200 tasks, subtasks included.',
  main_key_date: 'More than one key date is marked main.',
  choice_needs_options: 'A choice field has no options.',
  options_need_choice: 'options on a field that is not a choice.',
  project_not_found: 'project_id is not a live project the caller can open.',
  assignee_not_active: 'A named assignee is not an active team member.',
  member_not_active: 'A role default, role mapping or member field is not an active team member.',
  project_required: 'A run of a company-wide template needs project_id.',
  locked_to_project: "A run of a project's template named another project.",
  missing_values: 'A required fill-in field has no value.',
  missing_key_date: 'A key date has no date (only "start" defaults to today).',
  unknown_key_date: 'A date for a key date the template does not declare.',
  invalid_date: 'A date that is not a real calendar date.',
  role_unmapped: 'A required role (or the initiative owner role) has nobody.',
  cannot_assign_others: 'The run maps a role to someone else, which needs tasks.manage_all (403).',
  owner_not_found: "The initiative's owner is not an active member or a live group.",
};

/** The worked example: a product launch planned back from its launch date. */
export const PRODUCT_LAUNCH_EXAMPLE: TemplateDocumentInput = {
  name: 'Product launch',
  description: 'Everything a launch needs, planned back from the launch date.',
  project_id: null,
  guidance: 'Set the launch date from the release plan. The copywriter writes the announcement; the reviewer checks it before it goes out.',
  key_dates: [
    { key: 'kickoff', label: 'Kickoff' },
    { key: 'launch', label: 'Launch date', main: true },
  ],
  roles: [
    { key: 'designer', label: 'Designer', required: true },
    { key: 'copywriter', label: 'Copywriter' },
    { key: 'reviewer', label: 'Reviewer', default_member_id: null },
  ],
  fields: [
    { key: 'product', label: 'Product' },
    { key: 'tier', label: 'Launch tier', type: 'choice', options: ['Small', 'Major'] },
  ],
  items: [
    { key: 'brief', title: 'Write the {product} launch brief', assignee: 'runner', anchor: 'kickoff', due_in_days: 2 },
    {
      key: 'assets', title: 'Design the {product} launch assets', role: 'designer', anchor: 'launch', due_in_days: -14, depends_on: ['brief'],
      subtasks: [{ key: 'assets.social', title: 'Social cards for {product}', role: 'designer', anchor: 'launch', due_in_days: -12 }],
    },
    { key: 'copy', title: 'Write the {product} announcement ({tier} launch)', role: 'copywriter', anchor: 'launch', due_in_days: -7, depends_on: ['brief'] },
    { key: 'review', title: 'Review the {product} announcement', role: 'reviewer', anchor: 'launch', due_in_days: -3, depends_on: ['copy', 'assets'] },
    { key: 'ship', title: 'Launch {product}', priority: 'urgent', assignee: 'runner', anchor: 'launch', due_in_days: 0, depends_on: ['review'] },
    { key: 'retro', title: 'Review how the {product} launch went', anchor: 'launch', due_in_days: 14, depends_on: ['ship'] },
  ],
};

export function templateSchemaDocument() {
  return {
    schema_version: TEMPLATE_SCHEMA_VERSION,
    ...templateJsonSchemas(),
    rules: [
      'Every task and subtask has a key; the server gives t1, t2, t1.1 ... to any without one. Set your own keys for tasks others depend on.',
      'due_in_days counts from the task\'s anchor (a key date key; default the first key date). Negative is before it; null is no due date.',
      'depends_on lists keys of other top-level tasks; subtasks never depend. No loops.',
      'A task with a role is assigned to the member the run maps the role to (else its default member, else the task\'s own assignee).',
      'Every {key} in a title or description needs a field with that key.',
      'project_id set: the template belongs to that project; null: company-wide.',
      'Validate (POST /api/v1/task-templates/validate), then preview a run (POST /api/v1/task-templates/{id}/preview), then run.',
    ],
    error_codes: TEMPLATE_ERROR_CODES,
    example: PRODUCT_LAUNCH_EXAMPLE,
  };
}
