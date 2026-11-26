# Task templates for agents

A task template is a playbook set up once and run again and again: one task, or an ordered list of tasks with subtasks, planned around key dates, assigned by role, with dependencies. A run turns it into real tasks in a project, and, when you ask (`create_initiative: true`), a new initiative holding them.

An agent can write templates and run them over MCP or REST. The rules are strict and every refusal names exactly what to fix, so you can write, check, fix and retry without a person in the loop.

## The loop

1. **Read the schema**: `get_task_template_schema` (REST `GET /api/v1/task-templates/schema`). JSON Schema for the template, a change and a run, every error code, and the example below.
2. **Write the template as JSON** and **validate** it: `validate_task_template` (`POST /api/v1/task-templates/validate`). Nothing is saved. Fix every error, validate again.
3. **Create** it: `create_task_template` (`POST /api/v1/task-templates`). Send an `idempotency_key` (REST: `Idempotency-Key`) so a retry never makes two.
4. **Preview a run**: `preview_task_template_run` (`POST /api/v1/task-templates/{id}/preview`). The exact dated, assigned task list, dependencies and initiative. Nothing is written.
5. **Run** it with the same input: `run_task_template` (`POST /api/v1/task-templates/{id}/run`), with an `idempotency_key`.

To change a template: `update_task_template` (`PATCH /api/v1/task-templates/{id}`). Validate a change first by sending it with `template_id`.

## The template

| Property | What it is |
|---|---|
| `name` | 1 to 120 characters. |
| `description` | When to use it. Also the description of a run's initiative. |
| `project_id` | The project it belongs to (shown and run only there), or `null` for company-wide. |
| `guidance` | One note for whoever fills it in, a person or an agent: what to look at, how to pick dates. |
| `key_dates` | Named anchors: `[{ "key": "launch", "label": "Launch date", "main": true }]`, 1 to 10. Left out, one: `start`. `main` is the date a run's initiative targets (default the first). |
| `roles` | `[{ "key": "designer", "label": "Designer", "default_member_id": null, "required": true }]`, up to 20. A run maps each role to one member, a person or an agent. |
| `fields` | Fill-ins: `[{ "key": "product", "label": "Product", "type": "text" }]`, up to 10. `type` is `text` (default), `date` (YYYY-MM-DD), `member` (a member id; fills in their name) or `choice` (with `options`). `required` defaults to true. |
| `items` | The tasks in order, 1 to 50 (200 with subtasks). |

Each task in `items`:

| Property | What it is |
|---|---|
| `key` | Stable id: lowercase letters, numbers, `.`, `-`, `_`. Tasks without one get `t1`, `t2`, subtasks `t1.1`. Set your own on any task another depends on. |
| `title`, `description` | `{product}` is replaced by that field's value. Every `{key}` needs a field. |
| `priority`, `tags` | `low`, `medium` (default), `high`, `urgent`; up to 20 tags. |
| `anchor` | The key date its due date counts from. Default: the first key date. |
| `due_in_days` | Days from the anchor, -3650 to 3650. Negative is before it. `null`: no due date. |
| `role` | Assigned to the member the run maps this role to. |
| `assignee` | Used when no role is mapped: `"runner"` (whoever runs it), a member id, or `null`. |
| `depends_on` | Keys of other top-level tasks it waits on. Top-level tasks only, no loops. A run makes them real task dependencies. |
| `subtasks` | Up to 30, one level, the same properties except `depends_on`. |

## Worked example: a product launch

Planned back from the launch date, with a kickoff, three roles and a chain of dependencies.

```json
{
  "name": "Product launch",
  "description": "Everything a launch needs, planned back from the launch date.",
  "project_id": null,
  "guidance": "Set the launch date from the release plan. The copywriter writes the announcement; the reviewer checks it before it goes out.",
  "key_dates": [
    { "key": "kickoff", "label": "Kickoff" },
    { "key": "launch", "label": "Launch date", "main": true }
  ],
  "roles": [
    { "key": "designer", "label": "Designer", "required": true },
    { "key": "copywriter", "label": "Copywriter" },
    { "key": "reviewer", "label": "Reviewer", "default_member_id": null }
  ],
  "fields": [
    { "key": "product", "label": "Product" },
    { "key": "tier", "label": "Launch tier", "type": "choice", "options": ["Small", "Major"] }
  ],
  "items": [
    { "key": "brief", "title": "Write the {product} launch brief", "assignee": "runner", "anchor": "kickoff", "due_in_days": 2 },
    { "key": "assets", "title": "Design the {product} launch assets", "role": "designer", "anchor": "launch", "due_in_days": -14, "depends_on": ["brief"],
      "subtasks": [{ "key": "assets.social", "title": "Social cards for {product}", "role": "designer", "anchor": "launch", "due_in_days": -12 }] },
    { "key": "copy", "title": "Write the {product} announcement ({tier} launch)", "role": "copywriter", "anchor": "launch", "due_in_days": -7, "depends_on": ["brief"] },
    { "key": "review", "title": "Review the {product} announcement", "role": "reviewer", "anchor": "launch", "due_in_days": -3, "depends_on": ["copy", "assets"] },
    { "key": "ship", "title": "Launch {product}", "priority": "urgent", "assignee": "runner", "anchor": "launch", "due_in_days": 0, "depends_on": ["review"] },
    { "key": "retro", "title": "Review how the {product} launch went", "anchor": "launch", "due_in_days": 14, "depends_on": ["ship"] }
  ]
}
```

### Validate

A mistake, such as `"anchor": "go_live"` on `assets` and `copy` depending back on `review`, comes back as:

```json
{
  "valid": false,
  "errors": [
    { "path": "items[1].anchor", "code": "unknown_anchor", "message": "\"go_live\" is not one of this template's key dates", "hint": "Use one of: kickoff, launch. Or add { \"key\": \"go_live\", \"label\": \"...\" } to key_dates." },
    { "path": "items[2].depends_on[1]", "code": "dependency_cycle", "message": "These tasks wait on each other in a loop: copy waits on review waits on copy", "hint": "Remove one of these dependencies: copy on review, review on copy.", "cycle": ["copy", "review", "copy"] }
  ],
  "template": null,
  "can_save": true
}
```

Every error has a `path` (a JSON path into what you sent), a stable `code` to branch on, a `message` and a `hint` with the fix. Create and update refuse with exactly the same list (422, `details.errors`; `details.reason` is the first code). The codes are in `error_codes` on the schema endpoint.

### Preview

```json
{
  "template_id": "<id>",
  "project_id": "<project id>",
  "key_dates": { "kickoff": "2026-12-01", "launch": "2027-01-15" },
  "roles": { "designer": "<agent member id>", "copywriter": "<member id>", "reviewer": "runner" },
  "values": { "product": "Aurora", "tier": "Major" },
  "create_initiative": true,
  "initiative": { "owner_role": "designer" }
}
```

The answer lists every task with its key, title (fill-ins replaced), `due_date` (the brief 2026-12-03, assets 2027-01-01, the launch 2027-01-15, the retro 2027-01-29), `assignee_id` and subtasks; `dependencies` as `{ "task": "review", "waits_on": "assets" }`; and the initiative: "Product launch: Aurora, Major", active, target date 2027-01-15, owned by the designer. `ok: false` lists every reason the run would be refused, with paths such as `key_dates.launch` (`missing_key_date`) or `roles.designer` (`role_unmapped`).

### Run

Send the same input to `run_task_template`. The run makes the initiative (because the input asks for one), then every task inside it (each sends `task.created`), the dependencies, and records the run with a link from each task to its template item and planned due date. It answers `{ run, tasks, initiative, notes }` and sends one `template.run` webhook with `key_dates` and `initiative_id`.

## Rules worth knowing

- **Who may write**: a company-wide template needs `templates.manage`. A project's template needs `projects.manage` (whoever manages the project) or `templates.manage`, on a project you can open. Moving a template between scopes needs both.
- **Who may run**: `tasks.create` on the project. A project's template runs only in its project.
- **Assigning others**: a run that maps a role to anyone but you needs `tasks.manage_all` (403 `cannot_assign_others`). A role's default member and assignees written in the template stand, because the template's author chose them. Someone who cannot open the project is left unassigned, and `notes` says so.
- **Key dates**: every key date needs a date in the run, except `start`, which defaults to today (`start_date` sets it too).
- **Initiative**: off by default, so a run behaves as it always has. `create_initiative: true` makes one; `initiative.owner_role`, `owner_member_id` or `owner_group_id` picks one owner (default: you). Sending `initiative` without `create_initiative: true` is refused.
- **Agents whose new tasks need approval** cannot run templates; preview still works.
- **Older clients**: a client that replaces `items` without the newer item properties drops them for those tasks, and the tasks get new keys. Keep each task's `key` when you edit.
- **Idempotency**: create, update and run take an idempotency key; the same update sent twice also leaves one version.
