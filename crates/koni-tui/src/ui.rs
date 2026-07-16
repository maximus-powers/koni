use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::agent_chat::render_markdown_preserving_lines;
use crate::configure::{ConfigDomain, ConfigResource};
use crate::graph::{GraphEdgeRef, GraphRenderer, truncate_graph_line};
use crate::help::{HelpAction, HelpTopic};
use crate::model::{
    AnswerDraft, ApprovalDraft, ControlCenterModel, Dialog, EditScalarDraft, Focus, Mode,
    NewRunDraft, OverviewSubject, Panel, RunData, RunSummary, RunTypeOption,
    configured_orchestration_key_is_protected, durable_approved_plan_sections,
    question_allows_custom, question_answer_is_pending_resume, question_options,
};

const MIN_WIDTH: u16 = 82;
const MIN_HEIGHT: u16 = 20;
pub(crate) const CONFIG_DOMAIN_ROW_HEIGHT: u16 = 1;
pub(crate) const CONFIG_RESOURCE_CARD_HEIGHT: u16 = 2;

struct QuestionChoiceLines {
    lines: Vec<Line<'static>>,
    selected_line: usize,
}

/// The Questions panel and answer modal intentionally share this renderer so
/// previewing a decision never presents a second, subtly different UI.
fn question_choice_lines(
    options: &[(String, String, String, bool)],
    selected: usize,
    allow_custom: bool,
    width: usize,
) -> QuestionChoiceLines {
    let mut lines = Vec::new();
    let mut selected_line = 0;
    for (index, (_, label, description, recommended)) in options.iter().enumerate() {
        if index == selected {
            selected_line = lines.len();
        }
        lines.push(Line::styled(
            format!(
                "{} {}{}",
                if index == selected { "▸" } else { " " },
                label,
                if *recommended { "  ★" } else { "" }
            ),
            if index == selected {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        ));
        if index == selected && !description.trim().is_empty() {
            lines.extend(
                wrap_full_text(description, width.saturating_sub(4).max(1))
                    .into_iter()
                    .map(|line| {
                        Line::styled(format!("    {line}"), Style::default().fg(Color::DarkGray))
                    }),
            );
        }
    }
    if allow_custom {
        let index = options.len();
        if index == selected {
            selected_line = lines.len();
        }
        lines.push(Line::styled(
            format!(
                "{} None of the above",
                if index == selected { "▸" } else { " " }
            ),
            if index == selected {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        ));
        if index == selected {
            lines.extend(
                wrap_full_text(
                    "Write your own answer in the field below.",
                    width.saturating_sub(4).max(1),
                )
                .into_iter()
                .map(|line| {
                    Line::styled(format!("    {line}"), Style::default().fg(Color::DarkGray))
                }),
            );
        }
    }
    QuestionChoiceLines {
        lines,
        selected_line,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ConfigureLayout {
    pub(crate) draft_bar: Option<Rect>,
    pub(crate) domains: Rect,
    pub(crate) resources: Rect,
    pub(crate) editor: Rect,
}

pub(crate) fn configure_layout(area: Rect) -> ConfigureLayout {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(8), Constraint::Length(3)])
        .split(area);
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(25),
            Constraint::Percentage(30),
            Constraint::Min(32),
        ])
        .split(rows[0]);
    ConfigureLayout {
        draft_bar: Some(rows[1]),
        domains: columns[0],
        resources: columns[1],
        editor: columns[2],
    }
}

pub fn draw(frame: &mut Frame<'_>, model: &ControlCenterModel) {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        let message = format!(
            "Koni Control Center needs at least {MIN_WIDTH}×{MIN_HEIGHT}\ncurrent terminal: {}×{}",
            area.width, area.height
        );
        frame.render_widget(
            Paragraph::new(message).alignment(Alignment::Center).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" resize terminal "),
            ),
            area,
        );
        return;
    }
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(12),
            Constraint::Length(1),
        ])
        .split(area);
    draw_header(frame, model, vertical[0]);
    match model.mode {
        Mode::Operate => draw_operate(frame, model, vertical[1]),
        Mode::Configure => draw_configure(frame, model, vertical[1]),
    }
    draw_footer(frame, model, vertical[2]);
    if let Some(dialog) = &model.dialog {
        draw_dialog(frame, dialog, model);
    }
}

fn draw_dialog(frame: &mut Frame<'_>, dialog: &Dialog, model: &ControlCenterModel) {
    let area = match dialog {
        Dialog::Help(_) => centered_box(84, 24, frame.area()),
        Dialog::NewRun(draft) => new_run_dialog_area(frame.area(), draft, &model.run_types),
        Dialog::Approval(_) => centered_box(110, 36, frame.area()),
        Dialog::AnswerQuestion(draft) => {
            let width = frame.area().width.saturating_sub(4).min(92);
            centered_box(
                92,
                answer_question_dialog_height(draft, width),
                frame.area(),
            )
        }
        Dialog::ActionPalette(palette) => centered_box(
            76,
            (6 + u16::try_from(palette.filtered_actions().len()).unwrap_or(9) * 2).min(24),
            frame.area(),
        ),
        Dialog::ActionForm(draft) => centered_box(
            84,
            if draft.is_agent_guidance() {
                14
            } else {
                (9 + u16::try_from(draft.params.len()).unwrap_or(8) * 2).min(26)
            },
            frame.area(),
        ),
        Dialog::EditScalar(edit) => {
            edit_scalar_dialog_area(frame.area(), edit, model.config.selected_resource())
        }
        Dialog::NewConfigDocument(_) | Dialog::RenameConfigDocument(_) => {
            centered_box(76, 16, frame.area())
        }
        Dialog::RunTypeWizard(draft) => run_type_wizard_dialog_area(frame.area(), draft),
        Dialog::LegacyMigration(_) => centered_box(82, 18, frame.area()),
        Dialog::DeleteRun(_) => centered_box(82, 24, frame.area()),
        Dialog::MergeRun(_) => centered_box(96, 30, frame.area()),
    };
    frame.render_widget(Clear, area);
    match dialog {
        Dialog::Help(topic) => draw_help_dialog(frame, area, topic, model),
        Dialog::NewRun(draft) => draw_new_run_dialog(frame, area, draft, &model.run_types),
        Dialog::Approval(draft) => draw_approval_dialog(frame, area, draft),
        Dialog::AnswerQuestion(draft) => {
            let content_width = usize::from(area.width.saturating_sub(2)).max(1);
            let mut lines = vec![Line::styled(
                draft.batch_position.map_or_else(
                    || "Agent needs a decision".to_owned(),
                    |(ordinal, size)| format!("Question {ordinal}/{size}"),
                ),
                heading_style(),
            )];
            lines.extend(
                wrap_full_text(&draft.prompt, content_width)
                    .into_iter()
                    .map(Line::raw),
            );
            if !draft.context.is_empty() {
                lines.extend(
                    wrap_full_text(&draft.context, content_width)
                        .into_iter()
                        .map(|line| Line::styled(line, Style::default().fg(Color::DarkGray))),
                );
            }
            if draft.waiting_for_batch {
                let copy = format!(
                    "Saved draft · revise it here or answer the {} remaining batch question{} before planning resumes.",
                    draft.remaining_batch_questions,
                    if draft.remaining_batch_questions == 1 {
                        ""
                    } else {
                        "s"
                    }
                );
                lines.extend(
                    wrap_full_text(&copy, content_width)
                        .into_iter()
                        .map(|line| Line::styled(line, Style::default().fg(Color::LightBlue))),
                );
            } else if draft.pending_resume {
                lines.push(Line::styled(
                    "Answer is durable; the bound agent session still needs to resume.",
                    Style::default().fg(Color::Yellow),
                ));
            }
            if draft.submitted {
                lines.push(Line::styled(
                    if draft.waiting_for_batch {
                        "Updating saved answer…"
                    } else {
                        "Recording answer and resuming agent…"
                    },
                    Style::default().fg(Color::Yellow),
                ));
            }
            lines.push(Line::raw(""));
            lines.extend(
                question_choice_lines(
                    &draft.options,
                    draft.selected,
                    draft.allow_custom,
                    content_width,
                )
                .lines,
            );
            lines.push(Line::raw(""));
            let custom_selected = draft.allow_custom && draft.selected == draft.options.len();
            lines.push(Line::styled(
                if custom_selected {
                    format!(
                        "Your answer{}: {}",
                        if draft.custom_active { " ▸" } else { "" },
                        draft.custom
                    )
                } else {
                    format!(
                        "Notes (optional){}: {}",
                        if draft.custom_active { " ▸" } else { "" },
                        draft.custom
                    )
                },
                if draft.custom_active && (!draft.pending_resume || draft.waiting_for_batch) {
                    Style::default().fg(Color::Cyan)
                } else {
                    Style::default().fg(Color::DarkGray)
                },
            ));
            let controls = if draft.pending_resume && !draft.waiting_for_batch {
                "Enter retry resume · Esc close"
            } else if draft.custom_active {
                "↑/↓ select · type answer/notes · Tab choices · Enter submit · Esc cancel"
            } else {
                "↑/↓ or j/k select · Tab answer/notes · Enter submit · Esc cancel"
            };
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title(if draft.waiting_for_batch {
                                " Revise answer "
                            } else {
                                " Answer agent "
                            })
                            .title_bottom(control_tip(controls)),
                    )
                    .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::ActionPalette(palette) => {
            let mut lines = Vec::new();
            for (index, action) in palette.filtered_actions().iter().enumerate() {
                let selected = index == palette.selected;
                lines.push(Line::from(vec![
                    Span::styled(
                        if selected { "▸ " } else { "  " },
                        Style::default().fg(Color::Cyan),
                    ),
                    Span::styled(
                        action_label(action),
                        Style::default()
                            .fg(if selected { Color::Cyan } else { Color::White })
                            .add_modifier(if selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                ]));
                lines.push(Line::styled(
                    format!("    {}", action_description(action)),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            if lines.is_empty() {
                lines.push(Line::styled(
                    "No matching actions",
                    Style::default().fg(Color::DarkGray),
                ));
            }
            let filter = if palette.filter.is_empty() {
                String::new()
            } else {
                format!(" · filter: {}", palette.filter)
            };
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::Cyan))
                            .title(format!(" Available actions{filter} "))
                            .title_bottom(control_tip(
                                "Type to filter · Enter configure · Esc close",
                            )),
                    )
                    .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::EditScalar(edit) => {
            let resource = model.config.selected_resource();
            let (_, field) = resource.map_or_else(
                || form_path_parts(&edit.path),
                |resource| semantic_form_parts(resource, &edit.path),
            );
            let content_width = usize::from(area.width.saturating_sub(2).max(1));
            frame.render_widget(
                Paragraph::new(edit_scalar_dialog_lines(edit, content_width, resource)).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Cyan))
                        .title(format!(" Edit {field} "))
                        .title_bottom(control_tip(edit_scalar_controls())),
                ),
                area,
            );
        }
        Dialog::ActionForm(action) if action.is_agent_guidance() => {
            draw_agent_guidance_dialog(frame, area, action, model);
        }
        Dialog::ActionForm(action) => {
            let mut lines = vec![Line::styled(action_label(&action.action), heading_style())];
            if action.execution_root.is_some() {
                lines.push(Line::styled(
                    "✓ Selected ticket checkout",
                    Style::default().fg(Color::Green),
                ));
            }
            if action.params.is_empty() {
                lines.push(Line::raw("No parameters."));
            }
            for (index, param) in action.params.iter().enumerate() {
                let ticket_context = param.locked;
                let value = if ticket_context {
                    "bound to selected ticket".to_owned()
                } else if param.value.is_empty() {
                    "…".to_owned()
                } else {
                    param.value.clone()
                };
                lines.push(Line::styled(
                    format!(
                        "{} {}{}  {}",
                        if index == action.selected { "▸" } else { " " },
                        if ticket_context {
                            "Selected ticket".to_owned()
                        } else {
                            humanize(&param.id)
                        },
                        if param.required { "*" } else { "" },
                        value
                    ),
                    if index == action.selected {
                        Style::default().fg(Color::Cyan).bg(Color::DarkGray)
                    } else {
                        Style::default()
                    },
                ));
                if index == action.selected && !param.description.is_empty() {
                    lines.push(Line::styled(
                        format!("  {}", param.description),
                        Style::default().fg(Color::DarkGray),
                    ));
                }
            }
            lines.extend([
                Line::raw(""),
                Line::styled(
                    "Execution is compiler-mediated and lifecycle-validated.",
                    Style::default().fg(Color::Yellow),
                ),
            ]);
            let controls = if action.submitted {
                "Esc close · execution remains durable"
            } else {
                "Tab next parameter · Enter execute · Esc cancel"
            };
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::Cyan))
                            .title(" Configured action ")
                            .title_bottom(control_tip(controls)),
                    )
                    .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::NewConfigDocument(draft) => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::styled("Path below .codex/koni", heading_style()),
                    Line::raw(""),
                    Line::styled(
                        format!("▸ {}", draft.relative_path),
                        Style::default().fg(Color::Cyan).bg(Color::DarkGray),
                    ),
                    Line::raw(""),
                    Line::styled(
                        "The document is published only after full catalog/profile validation.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Cyan))
                        .title(" New configuration document ")
                        .title_bottom(control_tip("Enter create draft · Esc cancel")),
                )
                .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::RenameConfigDocument(draft) => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::styled("New path below .codex/koni", heading_style()),
                    Line::raw(""),
                    Line::styled(
                        format!("▸ {}", draft.relative_path),
                        Style::default().fg(Color::Cyan).bg(Color::DarkGray),
                    ),
                    Line::raw(""),
                    Line::styled(
                        "Rename and reference edits publish together after full validation.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Cyan))
                        .title(" Rename configuration document ")
                        .title_bottom(control_tip("Enter stage rename · Esc cancel")),
                )
                .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::RunTypeWizard(draft) => draw_run_type_wizard(frame, area, draft),
        Dialog::LegacyMigration(draft) => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::styled("Convert the Legacy project configuration", heading_style()),
                    Line::raw(""),
                    Line::raw(format!(
                        "Koni will prepare a canonical YAML catalog for {}.",
                        draft.profile_title
                    )),
                    Line::raw(""),
                    Line::styled("  ● profile.yaml", Style::default().fg(Color::Cyan)),
                    Line::styled("  ● project.yaml", Style::default().fg(Color::Cyan)),
                    Line::styled(
                        "  ● one faithful Legacy run type",
                        Style::default().fg(Color::Cyan),
                    ),
                    Line::styled(
                        "  ○ Legacy TOML staged for removal",
                        Style::default().fg(Color::Yellow),
                    ),
                    Line::raw(""),
                    Line::styled(
                        "Nothing is replaced now. Publication validates and replaces all files together.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Yellow))
                        .title(" Migrate Legacy configuration ")
                        .title_bottom(control_tip("Enter stage conversion · Esc cancel")),
                )
                .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::DeleteRun(draft) => {
            let preview = &draft.preview;
            let mut lines = delete_run_objective_preview_lines(
                &preview.goal,
                usize::from(area.width.saturating_sub(2)).max(1),
            );
            lines.extend([
                Line::styled(
                    format!("Current state · {}", humanize(&preview.run_status)),
                    Style::default().fg(status_color(&preview.run_status)),
                ),
                Line::raw(""),
                Line::styled("Koni-owned resources", heading_style()),
                Line::raw(format!(
                    "◇ {} worktree{} · {} owned branch{}",
                    preview.worktrees.len(),
                    plural(preview.worktrees.len()),
                    preview.owned_branches.len(),
                    plural(preview.owned_branches.len())
                )),
                Line::raw(format!(
                    "{} {} live agent{} · {} dirty worktree{}",
                    if preview.live_agents > 0 {
                        "⚙"
                    } else {
                        "○"
                    },
                    preview.live_agents,
                    plural(preview.live_agents),
                    preview.dirty_worktrees.len(),
                    plural(preview.dirty_worktrees.len())
                )),
            ]);
            if !preview.blockers.is_empty() {
                lines.push(Line::styled(
                    format!(
                        "! {} condition{} will be re-checked after agents stop",
                        preview.blockers.len(),
                        plural(preview.blockers.len())
                    ),
                    Style::default()
                        .fg(Color::LightRed)
                        .add_modifier(Modifier::BOLD),
                ));
            }
            lines.extend([
                Line::raw(""),
                Line::styled("Select an action", heading_style()),
            ]);
            for (index, (label, detail)) in [
                ("Cancel", "Keep this run and all of its resources."),
                (
                    "Remove run (preserve branches)",
                    "Safe default · removes owned runtime state and worktrees.",
                ),
                (
                    "Delete run and owned branches",
                    "Also removes branches whose ownership Koni can prove.",
                ),
            ]
            .iter()
            .enumerate()
            {
                let selected = index == draft.selected;
                lines.push(Line::styled(
                    format!("{} {label}", if selected { "▸" } else { " " }),
                    if selected {
                        Style::default()
                            .fg(if index == 2 {
                                Color::LightRed
                            } else {
                                Color::Cyan
                            })
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                    },
                ));
                if selected {
                    lines.push(Line::styled(
                        format!("    {detail}"),
                        Style::default().fg(Color::DarkGray),
                    ));
                }
            }
            lines.push(Line::raw(""));
            let (status, controls) = if draft.submitted {
                (
                    Some("Removing the selected run through the engine…"),
                    "Esc close; removal remains durable",
                )
            } else if draft.selected == 2 && draft.confirm_owned_branches {
                (
                    Some("Strong confirmation is required to delete proven owned branches."),
                    "Enter confirm branch deletion · Esc cancel",
                )
            } else if !preview.can_delete && draft.selected > 0 {
                (
                    Some("Run-owned agents must stop before file removal can be re-checked."),
                    "Enter stop agents and re-check · Esc cancel",
                )
            } else {
                (None, "↑/↓ or j/k select · Enter confirm · Esc cancel")
            };
            if let Some(status) = status {
                lines.push(Line::styled(
                    status,
                    Style::default().fg(if draft.selected == 2 {
                        Color::Yellow
                    } else {
                        Color::DarkGray
                    }),
                ));
            }
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::LightRed))
                            .title(" Delete run ")
                            .title_bottom(control_tip(controls)),
                    )
                    .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::MergeRun(draft) => draw_merge_run_dialog(frame, area, draft),
    }
}

fn delete_run_objective_preview_lines(objective: &str, width: usize) -> Vec<Line<'static>> {
    let objective = if objective.trim().is_empty() {
        "Selected run"
    } else {
        objective.trim()
    };
    let wrapped = objective
        .split('\n')
        .flat_map(|source| {
            if source.is_empty() {
                vec![String::new()]
            } else {
                wrap_full_text(source.trim_end_matches('\r'), width)
            }
        })
        .collect::<Vec<_>>();
    let truncated = wrapped.len() > 2;
    let mut visible = wrapped.into_iter().take(2).collect::<Vec<_>>();
    for line in &mut visible {
        *line = short_display_width(line, width);
    }
    if truncated && let Some(last) = visible.last_mut() {
        let with_ellipsis = format!("{}…", last.trim_end_matches('…'));
        *last = short_display_width(&with_ellipsis, width);
    }
    visible
        .into_iter()
        .map(|line| {
            Line::styled(
                line,
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )
        })
        .collect()
}

fn draw_merge_run_dialog(frame: &mut Frame<'_>, area: Rect, draft: &crate::model::MergeRunDraft) {
    let preview = &draft.preview;
    let target = preview
        .target_branch
        .strip_prefix("refs/heads/")
        .unwrap_or(&preview.target_branch);
    let checkout = preview.target_checkout.as_ref().map_or_else(
        || "not currently checked out".to_owned(),
        |path| path.display().to_string(),
    );
    let target_head = preview
        .target_head
        .as_deref()
        .map(short_revision)
        .unwrap_or_else(|| "missing".to_owned());
    let run_head = short_revision(&preview.run_head);

    let mut lines = vec![
        Line::styled(
            "Destination",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Line::from(vec![
            Span::styled("  Branch  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!(" {target} "),
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::LightGreen)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  at {target_head}"),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::styled(
            format!("  Checkout  {checkout}"),
            Style::default().fg(Color::DarkGray),
        ),
        Line::raw(""),
        Line::styled(
            "Prepared run",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Line::from(vec![
            Span::styled("  Commit  ", Style::default().fg(Color::DarkGray)),
            Span::styled(run_head, Style::default().fg(Color::Cyan)),
            Span::styled(
                format!("  ·  {}", humanize(&preview.current_stage)),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
    ];

    if preview.tickets.is_empty() {
        lines.push(Line::styled(
            "  No work tickets are attached to this promotion.",
            Style::default().fg(Color::DarkGray),
        ));
    } else {
        let completed = preview
            .tickets
            .iter()
            .filter(|ticket| matches!(ticket.status.as_str(), "completed" | "closed"))
            .count();
        lines.push(Line::styled(
            format!("  {completed}/{} tickets complete", preview.tickets.len()),
            Style::default().fg(if completed == preview.tickets.len() {
                Color::Green
            } else {
                Color::Yellow
            }),
        ));
        for ticket in preview.tickets.iter().take(4) {
            lines.push(Line::from(vec![
                Span::styled(
                    if matches!(ticket.status.as_str(), "completed" | "closed") {
                        "  ✓ "
                    } else {
                        "  ○ "
                    },
                    Style::default().fg(status_color(&ticket.status)),
                ),
                Span::styled(ticket.title.clone(), Style::default().fg(Color::Gray)),
            ]));
        }
        if preview.tickets.len() > 4 {
            lines.push(Line::styled(
                format!("    +{} more", preview.tickets.len() - 4),
                Style::default().fg(Color::DarkGray),
            ));
        }
    }

    lines.push(Line::raw(""));
    if preview.target_advanced {
        lines.push(Line::styled(
            "↻ The target advanced since the last sync. Koni will resynchronize and rerun downstream checks before promotion.",
            Style::default().fg(Color::Yellow),
        ));
    } else {
        lines.push(Line::styled(
            "✓ Target is synchronized with the verified run base.",
            Style::default().fg(Color::Green),
        ));
    }
    for blocker in preview.blockers.iter().take(4) {
        lines.push(Line::styled(
            format!("! {blocker}"),
            Style::default().fg(Color::LightRed),
        ));
    }

    lines.push(Line::raw(""));
    let button_label = if draft.submitted {
        " Authorizing merge… ".to_owned()
    } else if preview.can_authorize {
        format!(" Merge into {target} ")
    } else {
        " Merge unavailable ".to_owned()
    };
    lines.push(Line::from(vec![
        Span::raw("  "),
        Span::styled(
            button_label,
            if preview.can_authorize && !draft.submitted {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::LightGreen)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray).bg(Color::DarkGray)
            },
        ),
    ]));
    let controls = if preview.can_authorize {
        "Enter confirm branch promotion · Esc cancel"
    } else {
        "Esc close · refresh and select merge after resolving blockers"
    };

    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(if preview.can_authorize {
                        Color::LightGreen
                    } else {
                        Color::Yellow
                    }))
                    .title(" Merge run ")
                    .title_bottom(control_tip(controls)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn short_revision(revision: &str) -> String {
    revision.chars().take(8).collect()
}

fn draw_agent_guidance_dialog(
    frame: &mut Frame<'_>,
    area: Rect,
    action: &crate::model::ActionFormDraft,
    model: &ControlCenterModel,
) {
    let agents = model.selected_agent_summaries();
    let persona = agents
        .get(model.selected_agent)
        .map(|agent| agent.persona.as_str())
        .unwrap_or("agent");
    let message = action
        .params
        .iter()
        .find(|param| param.id == "message")
        .map(|param| param.value.as_str())
        .unwrap_or_default();
    let guidance_scope = if action.params.iter().any(|param| {
        matches!(param.id.as_str(), "ticket" | "ticket_id") && !param.value.trim().is_empty()
    }) {
        "selected ticket"
    } else {
        "selected run"
    };
    let content_width = usize::from(area.width.saturating_sub(6)).max(1);
    let input = if message.is_empty() {
        "Type guidance…".to_owned()
    } else {
        short(message, content_width)
    };
    let lines = vec![
        Line::styled(
            format!("Guidance for {persona}"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Line::styled(
            format!("This becomes durable guidance for the {guidance_scope}."),
            Style::default().fg(Color::Gray),
        ),
        Line::raw(""),
        Line::styled(
            format!("▸ {input}"),
            Style::default()
                .fg(if message.is_empty() {
                    Color::Gray
                } else {
                    Color::White
                })
                .bg(Color::DarkGray),
        ),
        Line::raw(""),
        Line::styled(
            "The current turn keeps its issued context; this is applied at the next compiler boundary.",
            Style::default().fg(Color::Yellow),
        ),
        Line::styled(
            if action.submitted {
                "Recording guidance…"
            } else {
                "Ready to record durable guidance."
            },
            Style::default().fg(Color::Cyan),
        ),
    ];
    let controls = if action.submitted {
        "Esc close; guidance remains durable"
    } else {
        "Enter send guidance · Esc cancel"
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" Send agent guidance ")
                    .title_bottom(control_tip(controls)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn answer_question_dialog_height(draft: &AnswerDraft, outer_width: u16) -> u16 {
    let width = usize::from(outer_width.saturating_sub(2)).max(1);
    let mut lines = 1 + wrap_full_text(&draft.prompt, width).len();
    if !draft.context.is_empty() {
        lines += wrap_full_text(&draft.context, width).len();
    }
    if draft.waiting_for_batch || draft.pending_resume || draft.submitted {
        let status = if draft.waiting_for_batch {
            format!(
                "Saved draft · revise it here or answer the {} remaining batch question{} before planning resumes.",
                draft.remaining_batch_questions,
                if draft.remaining_batch_questions == 1 {
                    ""
                } else {
                    "s"
                }
            )
        } else if draft.pending_resume {
            "Answer is durable; the bound agent session still needs to resume.".to_owned()
        } else {
            "Recording answer and resuming agent…".to_owned()
        };
        lines += wrap_full_text(&status, width).len();
        if draft.submitted && (draft.waiting_for_batch || draft.pending_resume) {
            lines += 1;
        }
    }
    lines += 1;
    lines += question_choice_lines(&draft.options, draft.selected, draft.allow_custom, width)
        .lines
        .len();
    lines += 1;
    let custom = if draft.allow_custom && draft.selected == draft.options.len() {
        format!("Your answer: {}", draft.custom)
    } else {
        format!("Notes (optional): {}", draft.custom)
    };
    lines += wrap_full_text(&custom, width).len();
    // The control tip is carried by the modal's bottom border, not the body.
    lines += 1;
    u16::try_from(lines.saturating_add(2))
        .unwrap_or(u16::MAX)
        .max(12)
}

fn draw_approval_dialog(frame: &mut Frame<'_>, area: Rect, draft: &ApprovalDraft) {
    let outer = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" Review plan ");
    let inner = outer.inner(area);
    frame.render_widget(outer, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(5),
            Constraint::Length(9),
            Constraint::Length(1),
        ])
        .split(inner);

    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled("Goal  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    short(&draft.goal, usize::from(rows[0].width.saturating_sub(6))),
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::styled(
                format!("Run type  {}", draft.run_type_title),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        rows[0],
    );

    let mut tab_spans = vec![Span::raw(" ")];
    for (index, section) in draft.sections.iter().enumerate() {
        let label = section.title.as_str();
        let selected = index == draft.selected_section;
        tab_spans.push(Span::styled(
            format!(" {label} "),
            if selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ));
        tab_spans.push(Span::raw(" "));
    }
    let section = draft.selected_section();
    let content_block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(tab_spans).alignment(Alignment::Center));
    let content_inner = content_block.inner(rows[1]);
    frame.render_widget(content_block, rows[1]);
    let body = section.map_or("No durable review text is available.", |section| {
        section.body.as_str()
    });
    let body_lines = approval_markdown_lines(body, usize::from(content_inner.width).max(1));
    let visible = usize::from(content_inner.height).max(1);
    let max_scroll = body_lines.len().saturating_sub(visible);
    let scroll = draft.scroll.min(max_scroll);
    let end = scroll.saturating_add(visible).min(body_lines.len());
    frame.render_widget(
        Paragraph::new(body_lines[scroll..end].to_vec()),
        content_inner,
    );
    let action_rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(6),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(rows[2]);
    let editor_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if draft.revision_focused {
            Color::Cyan
        } else {
            Color::DarkGray
        }))
        .title(
            Line::styled(
                " Steering instructions ",
                Style::default()
                    .fg(if draft.revision_focused {
                        Color::Cyan
                    } else {
                        Color::Gray
                    })
                    .add_modifier(if draft.revision_focused {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            )
            .alignment(Alignment::Center),
        );
    let editor_inner = editor_block.inner(action_rows[0]);
    frame.render_widget(editor_block, action_rows[0]);
    frame.render_widget(
        Paragraph::new(approval_revision_editor_lines(
            draft,
            editor_inner.width,
            editor_inner.height,
        ))
        .style(if draft.revision_focused {
            Style::default().bg(Color::DarkGray)
        } else {
            Style::default()
        }),
        editor_inner,
    );

    let has_steering = !draft.revision.trim().is_empty();
    let action_label = if has_steering {
        "Revise plan"
    } else {
        "Approve run"
    };
    let action_enabled = !draft.submitted && (has_steering || draft.approval_enabled);
    let action_style = primary_modal_button_style(draft.action_focused, action_enabled);
    let buttons = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Fill(1),
            Constraint::Length(17),
            Constraint::Fill(1),
        ])
        .split(action_rows[1]);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!("  {action_label}  "),
            action_style,
        )))
        .alignment(Alignment::Center),
        buttons[1],
    );

    let note = if draft.submitted {
        if has_steering {
            "Regenerating the planning artifacts…"
        } else {
            "Creating the approved run…"
        }
    } else if draft.revision_focused {
        "Enter newline · arrows/Home/End move · Ctrl+Enter submit · Tab selects the action"
    } else if draft.action_focused {
        if has_steering {
            "Enter sends the plan back for revision."
        } else if draft.approval_enabled {
            "Enter approves the plans and creates the integration branch."
        } else {
            draft
                .blockers
                .first()
                .map(String::as_str)
                .unwrap_or("Required planning output is incomplete.")
        }
    } else {
        "Tab selects the steering editor or primary action. Full artifacts remain available."
    };
    frame.render_widget(
        Paragraph::new(Line::styled(
            short(note, usize::from(action_rows[2].width)),
            Style::default().fg(Color::DarkGray),
        ))
        .alignment(Alignment::Center),
        action_rows[2],
    );
    let controls = "←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc";
    frame.render_widget(
        Paragraph::new(controls)
            .style(Style::default().fg(Color::DarkGray))
            .alignment(Alignment::Center),
        rows[3],
    );
}

fn primary_modal_button_style(focused: bool, enabled: bool) -> Style {
    if !enabled {
        Style::default().fg(Color::Gray).bg(Color::DarkGray)
    } else if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Cyan).bg(Color::DarkGray)
    }
}

fn approval_revision_editor_lines(
    draft: &ApprovalDraft,
    width: u16,
    height: u16,
) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let value_style = if draft.revision_focused {
        Style::default().fg(Color::White).bg(Color::DarkGray)
    } else {
        Style::default().fg(Color::Gray)
    };
    let caret_style = Style::default()
        .fg(Color::Black)
        .bg(Color::Cyan)
        .add_modifier(Modifier::BOLD);
    let mut wrapped = if draft.revision.is_empty() {
        if draft.revision_focused {
            vec![Line::from(vec![
                Span::styled("▏", caret_style),
                Span::styled(
                    " Type what should change…",
                    Style::default().fg(Color::Gray),
                ),
            ])]
        } else {
            vec![Line::styled(
                "Add steering here to request a revised plan…",
                value_style,
            )]
        }
    } else {
        multiline_editor_value_lines(
            &draft.revision,
            draft.revision_focused.then_some(draft.revision_cursor),
            width,
            value_style,
            caret_style,
        )
    };
    if wrapped.is_empty() {
        wrapped.push(Line::raw(""));
    }

    let visible_rows = usize::from(height.max(1));
    let caret_row = wrapped
        .iter()
        .position(|line| line.spans.iter().any(|span| span.style == caret_style));
    let max_start = wrapped.len().saturating_sub(visible_rows);
    let start = caret_row
        .map_or(0, |row| row.saturating_sub(visible_rows - 1))
        .min(max_start);
    (0..visible_rows)
        .map(|offset| wrapped.get(start + offset).cloned().unwrap_or_default())
        .collect()
}

fn approval_markdown_lines(body: &str, width: usize) -> Vec<Line<'static>> {
    render_markdown_preserving_lines(body, width)
        .into_iter()
        .map(|mut line| {
            let text = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>();
            let semantic = text
                .trim_start()
                .strip_prefix('•')
                .map(str::trim_start)
                .unwrap_or_else(|| text.trim_start());
            let heading = line.spans.iter().any(|span| {
                span.style.fg == Some(Color::Cyan)
                    && span.style.add_modifier.contains(Modifier::BOLD)
            });
            if semantic.starts_with("Decision:") {
                for span in &mut line.spans {
                    let content = span.content.trim();
                    if !content.is_empty()
                        && content != "•"
                        && span.style.fg != Some(Color::LightBlue)
                    {
                        span.style = span.style.fg(Color::LightGreen);
                    }
                }
            } else if semantic.starts_with("Notes:") {
                for span in &mut line.spans {
                    if !span.content.trim().is_empty() {
                        span.style = span.style.fg(Color::DarkGray);
                    }
                }
            } else if !heading && !semantic.is_empty() {
                for span in &mut line.spans {
                    if !span.content.trim().is_empty() && span.style.fg.is_none() {
                        span.style = span.style.fg(Color::Gray);
                    }
                }
            }
            line
        })
        .collect()
}

fn draw_help_dialog(
    frame: &mut Frame<'_>,
    area: Rect,
    topic: &HelpTopic,
    model: &ControlCenterModel,
) {
    let mut content = topic.content();
    if matches!(topic, HelpTopic::Runs) {
        let controls = configured_runs_orchestration_help_actions(model);
        let insertion = content.actions.len().min(4);
        content.actions.splice(insertion..insertion, controls);
    }
    let compact = area.height < 24;
    let spacer = || {
        if compact {
            Vec::new()
        } else {
            vec![Line::raw("")]
        }
    };
    let mut lines = vec![
        Line::styled(
            "WHAT THIS IS",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Line::raw(content.summary),
    ];
    lines.extend(spacer());
    lines.extend([
        Line::styled(
            "IN THE WORKFLOW",
            Style::default()
                .fg(Color::LightBlue)
                .add_modifier(Modifier::BOLD),
        ),
        Line::raw(content.workflow),
    ]);
    lines.extend(spacer());
    lines.extend([Line::styled(
        "AVAILABLE HERE",
        Style::default()
            .fg(Color::LightMagenta)
            .add_modifier(Modifier::BOLD),
    )]);
    lines.extend(content.actions.into_iter().map(|action| {
        Line::from(vec![
            Span::styled(
                format!("  {:<18}", action.keys),
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::raw(action.description),
        ])
    }));
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(format!(" Help · {} ", content.title))
                    .title_alignment(Alignment::Center)
                    .title_bottom(control_tip("Close: h · Esc · Enter · q · F1")),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn configured_runs_orchestration_help_actions(model: &ControlCenterModel) -> Vec<HelpAction> {
    let Some(run) = model.selected_run_data() else {
        return Vec::new();
    };
    if run.orchestration.is_none()
        || run
            .summary
            .as_ref()
            .is_none_or(|summary| summary.status != "active")
    {
        return Vec::new();
    }
    let Some(bindings) = selected_orchestration_keybindings(model) else {
        return Vec::new();
    };

    // Runtime dispatch chooses the first control claiming a key. Mirror that here so help never
    // advertises a second, unreachable action for an accidentally duplicated binding.
    let mut claimed_keys = BTreeSet::new();
    let mut toggle = None;
    let mut parallel = Vec::new();
    let mut unchained = None;
    for (control, binding) in bindings {
        let Some(raw_key) = binding.as_str() else {
            continue;
        };
        let Some(display_key) = dispatchable_orchestration_display_key(raw_key) else {
            continue;
        };
        if !claimed_keys.insert(raw_key.to_owned()) {
            continue;
        }
        match control.as_str() {
            "toggle" => toggle = Some((raw_key, display_key)),
            "unchained" => unchained = Some(display_key),
            control if control.starts_with("parallel_") => {
                if let Some(count) = control
                    .strip_prefix("parallel_")
                    .and_then(|count| count.parse::<usize>().ok())
                {
                    parallel.push((count, display_key));
                }
            }
            _ => {}
        }
    }

    let mut actions = Vec::new();
    if let Some((raw_key, display_key)) = toggle {
        let state = if model.orchestration_running {
            "Pause orchestration"
        } else {
            "Resume orchestration"
        };
        let description = if raw_key == "space" {
            // Runs owns Space for whole-run pause/resume. The same configured orchestration key is
            // effective from the other Operate panels, so say that instead of promising a control
            // this panel intentionally protects.
            format!("{state} outside Runs")
        } else {
            state.to_owned()
        };
        actions.push(HelpAction::new(display_key, description));
    }

    parallel.sort_by_key(|(count, _)| *count);
    let mut mode_keys = parallel
        .iter()
        .map(|(_, key)| key.clone())
        .collect::<Vec<_>>();
    let mut mode_labels = parallel
        .iter()
        .map(|(count, _)| format!("Parallel {count}"))
        .collect::<Vec<_>>();
    if let Some(key) = unchained {
        mode_keys.push(key);
        mode_labels.push("Unchained".to_owned());
    }
    if !mode_keys.is_empty() {
        actions.push(HelpAction::new(
            mode_keys.join(" / "),
            mode_labels.join(" / "),
        ));
    }
    actions
}

fn dispatchable_orchestration_display_key(key: &str) -> Option<String> {
    if key == "space" {
        return Some("Space".to_owned());
    }
    let mut characters = key.chars();
    let character = characters.next()?;
    if characters.next().is_some()
        || character.is_control()
        || character == ' '
        || configured_orchestration_key_is_protected(character)
    {
        return None;
    }
    Some(character.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WizardTemplateChip {
    index: usize,
    row: u16,
    x: u16,
    width: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunTypeWizardHit {
    Template(usize),
    Field(usize),
    Create,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SelectorRowWindow {
    start: u16,
    end: u16,
    total: u16,
}

impl SelectorRowWindow {
    fn selected(total: u16, selected: u16, capacity: u16) -> Self {
        let capacity = capacity.max(1);
        let total = total.max(1);
        let selected = selected.min(total.saturating_sub(1));
        let start = selected / capacity * capacity;
        Self {
            start,
            end: start.saturating_add(capacity).min(total),
            total,
        }
    }

    fn is_paged(self) -> bool {
        self.start > 0 || self.end < self.total
    }
}

fn selector_heading(
    label: &str,
    visible_indices: impl Iterator<Item = usize>,
    total_items: usize,
    window: SelectorRowWindow,
) -> String {
    if !window.is_paged() {
        return label.to_owned();
    }
    let indices = visible_indices.collect::<Vec<_>>();
    let first = indices.first().copied().unwrap_or_default() + 1;
    let last = indices.last().copied().unwrap_or_default() + 1;
    format!("{label} · showing {first}–{last} of {total_items}")
}

fn wizard_template_chip_layout(
    draft: &crate::model::RunTypeWizardDraft,
    width: u16,
) -> Vec<WizardTemplateChip> {
    let mut row = 0_u16;
    let mut x = 0_u16;
    draft
        .templates
        .iter()
        .enumerate()
        .map(|(index, template)| {
            let natural_width = u16::try_from(template.label.chars().count())
                .unwrap_or(u16::MAX)
                .saturating_add(4);
            let chip_width = natural_width.min(width.max(1));
            if x > 0 && x.saturating_add(chip_width) > width {
                row = row.saturating_add(1);
                x = 0;
            }
            let chip = WizardTemplateChip {
                index,
                row,
                x,
                width: chip_width,
            };
            x = x.saturating_add(chip_width).saturating_add(1);
            chip
        })
        .collect()
}

fn wizard_template_chip_page(
    draft: &crate::model::RunTypeWizardDraft,
    width: u16,
    area_height: u16,
) -> (Vec<WizardTemplateChip>, SelectorRowWindow) {
    let mut chips = wizard_template_chip_layout(draft, width);
    let total_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let selected_row = chips
        .get(draft.selected_template)
        .map_or(0, |chip| chip.row);
    // Borders plus the description, form, create button, and help occupy 16 rows.
    let capacity = area_height.saturating_sub(16).max(1);
    let window = SelectorRowWindow::selected(total_rows, selected_row, capacity);
    chips.retain(|chip| chip.row >= window.start && chip.row < window.end);
    for chip in &mut chips {
        chip.row -= window.start;
    }
    (chips, window)
}

fn run_type_wizard_dialog_area(screen: Rect, draft: &crate::model::RunTypeWizardDraft) -> Rect {
    let width = screen.width.saturating_sub(4).min(96);
    let rows = wizard_template_chip_layout(draft, width.saturating_sub(2).max(1))
        .last()
        .map_or(1, |chip| chip.row + 1);
    centered_box(96, rows.saturating_add(21).min(34), screen)
}

fn draw_run_type_wizard(
    frame: &mut Frame<'_>,
    area: Rect,
    draft: &crate::model::RunTypeWizardDraft,
) {
    let inner_width = area.width.saturating_sub(2).max(1);
    let (chips, window) = wizard_template_chip_page(draft, inner_width, area.height);
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let mut lines = vec![Line::styled(
        selector_heading(
            "Start from",
            chips.iter().map(|chip| chip.index),
            draft.templates.len(),
            window,
        ),
        Style::default()
            .fg(if draft.active_field == 0 {
                Color::Cyan
            } else {
                Color::DarkGray
            })
            .add_modifier(Modifier::BOLD),
    )];
    for row in 0..chip_rows {
        let mut spans = Vec::new();
        let mut cursor = 0_u16;
        for chip in chips.iter().filter(|chip| chip.row == row) {
            if chip.x > cursor {
                spans.push(Span::raw(" ".repeat(usize::from(chip.x - cursor))));
            }
            let template = &draft.templates[chip.index];
            let selected = chip.index == draft.selected_template;
            let label_width = usize::from(chip.width.saturating_sub(4));
            spans.push(Span::styled(
                format!("  {:<label_width$}  ", short(&template.label, label_width)),
                if selected {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White).bg(Color::DarkGray)
                },
            ));
            cursor = chip.x.saturating_add(chip.width);
        }
        lines.push(Line::from(spans));
    }
    if let Some(template) = draft.templates.get(draft.selected_template) {
        lines.push(Line::styled(
            short(&template.description, usize::from(inner_width)),
            Style::default().fg(Color::Gray),
        ));
    }
    lines.push(Line::raw(""));
    let fields = [
        ("Title", draft.title.as_str()),
        ("Slug", draft.slug.as_str()),
        ("Description", draft.description.as_str()),
    ];
    for (offset, (label, value)) in fields.into_iter().enumerate() {
        let field = offset + 1;
        let selected = draft.active_field == field;
        lines.push(Line::styled(
            short(label, usize::from(inner_width)),
            Style::default()
                .fg(if selected {
                    Color::Cyan
                } else {
                    Color::DarkGray
                })
                .add_modifier(Modifier::BOLD),
        ));
        lines.push(Line::styled(
            short(
                &format!("{}{}", if selected { "▸ " } else { "  " }, value),
                usize::from(inner_width),
            ),
            if selected {
                Style::default().bg(Color::DarkGray)
            } else {
                Style::default()
            },
        ));
    }
    lines.push(Line::styled(
        format!(
            "{} {} Make this the default run type",
            if draft.active_field == 4 { "▸" } else { " " },
            if draft.make_default { "●" } else { "○" }
        ),
        if draft.active_field == 4 {
            Style::default().fg(Color::Cyan).bg(Color::DarkGray)
        } else {
            Style::default()
        },
    ));
    lines.push(Line::raw(""));
    lines.push(Line::styled(
        format!(
            "{}  Create staged run type  ",
            if draft.active_field == 5 { "▸" } else { " " }
        ),
        if draft.active_field == 5 {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White).bg(Color::DarkGray)
        },
    ));
    lines.push(Line::styled(
        short(
            "Creates a standalone draft for review and later publication.",
            usize::from(inner_width),
        ),
        Style::default().fg(Color::Yellow),
    ));
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" New run type · guided setup ")
                    .title_bottom(control_tip(
                        "Tab/↑↓/jk move · ←→/[] change · Home/End · Enter next · F5 create · Esc",
                    )),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

pub(crate) fn run_type_wizard_hit_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    size: ratatui::layout::Size,
) -> Option<RunTypeWizardHit> {
    let Dialog::RunTypeWizard(draft) = model.dialog.as_ref()? else {
        return None;
    };
    let area = run_type_wizard_dialog_area(Rect::new(0, 0, size.width, size.height), draft);
    let (chips, _) =
        wizard_template_chip_page(draft, area.width.saturating_sub(2).max(1), area.height);
    if let Some(chip) = chips.iter().find(|chip| {
        let x = area.x.saturating_add(1).saturating_add(chip.x);
        let y = area.y.saturating_add(2).saturating_add(chip.row);
        column >= x && column < x.saturating_add(chip.width) && row == y
    }) {
        return Some(RunTypeWizardHit::Template(chip.index));
    }
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let first_field_y = area.y.saturating_add(4).saturating_add(chip_rows);
    for field in 1..=3_usize {
        let y = first_field_y.saturating_add(u16::try_from((field - 1) * 2).unwrap_or(0));
        if row == y || row == y.saturating_add(1) {
            return Some(RunTypeWizardHit::Field(field));
        }
    }
    let default_y = first_field_y.saturating_add(6);
    if row == default_y {
        return Some(RunTypeWizardHit::Field(4));
    }
    if row == default_y.saturating_add(2) {
        return Some(RunTypeWizardHit::Create);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RunTypeChip {
    index: usize,
    row: u16,
    x: u16,
    width: u16,
}

fn new_run_dialog_area(screen: Rect, draft: &NewRunDraft, run_types: &[RunTypeOption]) -> Rect {
    let width = screen.width.saturating_sub(4).min(108);
    let inner_width = width.saturating_sub(2).max(1);
    let objective_rows = new_run_objective_rows(screen.height);
    let prompt_rows = objective_rows.saturating_add(
        u16::try_from(draft.intake_fields.len())
            .unwrap_or(u16::MAX)
            .saturating_mul(2),
    );
    let stage_rows = u16::try_from(
        workflow_stage_rows(run_types, &draft.run_type, inner_width)
            .iter()
            .map(Vec::len)
            .sum::<usize>(),
    )
    .unwrap_or(u16::MAX);
    let gap = new_run_section_gap(screen.height.saturating_sub(2));
    let base_height = 17_u16.saturating_add(gap.saturating_mul(5));
    let one_chip_row_height = base_height
        .saturating_add(prompt_rows)
        .saturating_add(stage_rows);
    let chip_layout = run_type_chip_layout(run_types, inner_width);
    let chips_inline = run_type_layout_fits_inline(&chip_layout, inner_width);
    let chip_rows = chip_layout
        .last()
        .map_or(1, |chip| chip.row + 1)
        .min(if one_chip_row_height >= 30 { 3 } else { 1 });
    let chip_extra_rows = if chips_inline { 0 } else { chip_rows };
    let natural_height = base_height
        .saturating_add(prompt_rows)
        .saturating_add(chip_extra_rows)
        .saturating_add(stage_rows)
        .min(40)
        .max(if gap > 0 { 28 } else { 0 });
    if screen.height <= 22 {
        let height = natural_height.min(screen.height);
        Rect::new(
            screen.x + screen.width.saturating_sub(width) / 2,
            screen.y + screen.height.saturating_sub(height) / 2,
            width,
            height,
        )
    } else {
        centered_box(108, natural_height, screen)
    }
}

fn new_run_section_gap(dialog_height: u16) -> u16 {
    u16::from(dialog_height >= 30)
}

fn new_run_objective_rows(dialog_height: u16) -> u16 {
    if dialog_height >= 30 { 4 } else { 2 }
}

fn new_run_prompt_row_height(index: usize, objective_rows: u16) -> u16 {
    if index == 0 { objective_rows } else { 2 }
}

fn new_run_prompt_window(
    draft: &NewRunDraft,
    available_rows: u16,
    objective_rows: u16,
) -> (usize, usize, u16) {
    let total = 1 + draft.intake_fields.len();
    let active = draft.active_field.min(total.saturating_sub(1));
    let available_rows = available_rows.max(new_run_prompt_row_height(active, objective_rows));
    let all_rows = (0..total).fold(0_u16, |rows, index| {
        rows.saturating_add(new_run_prompt_row_height(index, objective_rows))
    });
    if all_rows <= available_rows {
        return (0, total, all_rows);
    }
    let mut start = 0;
    loop {
        let mut end = start;
        let mut rows = 0_u16;
        while end < total {
            let height = new_run_prompt_row_height(end, objective_rows);
            if end > start && rows.saturating_add(height) > available_rows {
                break;
            }
            rows = rows.saturating_add(height);
            end += 1;
        }
        if active < end || end >= total {
            return (start, end, rows);
        }
        start = end;
    }
}

fn run_type_chip_layout(run_types: &[RunTypeOption], width: u16) -> Vec<RunTypeChip> {
    let mut row = 0_u16;
    let mut x = 0_u16;
    run_types
        .iter()
        .enumerate()
        .map(|(index, run_type)| {
            let natural_width = u16::try_from(run_type.title.chars().count())
                .unwrap_or(u16::MAX)
                .saturating_add(4);
            let chip_width = natural_width.min(width.max(1));
            if x > 0 && x.saturating_add(chip_width) > width {
                row = row.saturating_add(1);
                x = 0;
            }
            let chip = RunTypeChip {
                index,
                row,
                x,
                width: chip_width,
            };
            x = x.saturating_add(chip_width).saturating_add(1);
            chip
        })
        .collect()
}

fn run_type_chip_page(
    draft: &NewRunDraft,
    run_types: &[RunTypeOption],
    width: u16,
    area_height: u16,
) -> (Vec<RunTypeChip>, SelectorRowWindow) {
    let mut chips = run_type_chip_layout(run_types, width);
    let total_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let selected_index = run_types
        .iter()
        .position(|run_type| run_type.id == draft.run_type)
        .unwrap_or_default();
    let selected_row = chips.get(selected_index).map_or(0, |chip| chip.row);
    let capacity = if area_height >= 30 { 3 } else { 1 }.min(total_rows);
    let window = SelectorRowWindow::selected(total_rows, selected_row, capacity);
    chips.retain(|chip| chip.row >= window.start && chip.row < window.end);
    for chip in &mut chips {
        chip.row -= window.start;
    }
    (chips, window)
}

fn run_type_layout_fits_inline(chips: &[RunTypeChip], width: u16) -> bool {
    let prefix = u16::try_from(2 + CONFIG_CONTROL_LABEL_WIDTH).unwrap_or(u16::MAX);
    chips.iter().all(|chip| chip.row == 0)
        && chips
            .last()
            .is_none_or(|chip| prefix.saturating_add(chip.x).saturating_add(chip.width) <= width)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NewRunFieldWindow {
    start: usize,
    end: usize,
    total: usize,
}

impl NewRunFieldWindow {
    fn is_paged(self) -> bool {
        self.start > 0 || self.end < self.total
    }
}

fn new_run_field_window(
    draft: &NewRunDraft,
    field_count: usize,
    available_rows: u16,
) -> NewRunFieldWindow {
    let active = draft
        .active_field
        .saturating_sub(1)
        .min(field_count.saturating_sub(1));
    let active_has_description = draft
        .active_field
        .checked_sub(4)
        .and_then(|index| draft.intake_fields.get(index))
        .is_some_and(|field| !field.description.is_empty() || !field.options.is_empty());
    let row_height =
        |index: usize| 2_u16.saturating_add(u16::from(index == active && active_has_description));
    let all_rows =
        (0..field_count).fold(0_u16, |rows, index| rows.saturating_add(row_height(index)));
    if all_rows <= available_rows {
        return NewRunFieldWindow {
            start: 0,
            end: field_count,
            total: field_count,
        };
    }

    // One line identifies the visible field range whenever the form is paged.
    let page_rows = available_rows.saturating_sub(1).max(row_height(active));
    let mut start = 0;
    loop {
        let mut end = start;
        let mut used = 0_u16;
        while end < field_count {
            let height = row_height(end);
            if end > start && used.saturating_add(height) > page_rows {
                break;
            }
            used = used.saturating_add(height);
            end += 1;
        }
        if active < end || end >= field_count {
            return NewRunFieldWindow {
                start,
                end,
                total: field_count,
            };
        }
        start = end;
    }
}

#[allow(dead_code)]
fn draw_new_run_dialog_legacy(
    frame: &mut Frame<'_>,
    area: Rect,
    draft: &NewRunDraft,
    run_types: &[RunTypeOption],
) {
    let inner_width = area.width.saturating_sub(2).max(1);
    let (chips, window) = run_type_chip_page(draft, run_types, inner_width, area.height);
    let mut lines = vec![Line::styled(
        selector_heading(
            "Run type",
            chips.iter().map(|chip| chip.index),
            run_types.len(),
            window,
        ),
        Style::default()
            .fg(if draft.active_field == 0 {
                Color::Cyan
            } else {
                Color::DarkGray
            })
            .add_modifier(Modifier::BOLD),
    )];
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    for row in 0..chip_rows {
        let mut spans = Vec::new();
        let mut cursor = 0_u16;
        for chip in chips.iter().filter(|chip| chip.row == row) {
            if chip.x > cursor {
                spans.push(Span::raw(" ".repeat(usize::from(chip.x - cursor))));
            }
            let run_type = &run_types[chip.index];
            let selected = run_type.id == draft.run_type;
            let max_title_width = usize::from(chip.width.saturating_sub(4));
            let title = short(&run_type.title, max_title_width);
            let label = format!("  {title:<max_title_width$}  ");
            spans.push(Span::styled(
                label,
                if selected {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White).bg(Color::DarkGray)
                },
            ));
            cursor = chip.x.saturating_add(chip.width);
        }
        lines.push(Line::from(spans));
    }

    if let Some(selected) = run_types
        .iter()
        .find(|run_type| run_type.id == draft.run_type)
    {
        if !selected.description.is_empty() {
            lines.push(Line::styled(
                short(&selected.description, usize::from(inner_width)),
                Style::default().fg(Color::Gray),
            ));
        }
        let planning = match selected.planning_passes {
            0 => "No agent planning pass".to_owned(),
            1 => "1 planning pass".to_owned(),
            count => format!("{count} planning passes"),
        };
        let parallel = selected.max_parallel.map_or_else(
            || "profile parallelism".to_owned(),
            |count| format!("{count} parallel"),
        );
        lines.push(Line::styled(
            short(
                &format!(
                    "{planning} · planning questions: {} · {parallel}",
                    humanize(&selected.question_policy).to_lowercase()
                ),
                usize::from(inner_width),
            ),
            Style::default().fg(Color::LightBlue),
        ));
        if let Some(models) = &selected.model_summary {
            lines.push(Line::styled(
                short(&format!("Models · {models}"), usize::from(inner_width)),
                Style::default().fg(Color::DarkGray),
            ));
        }
    }

    let mut fields = vec![
        ("Objective".to_owned(), draft.goal.clone(), String::new()),
        (
            "Target branch".to_owned(),
            draft.target_branch.clone(),
            String::new(),
        ),
        (
            "Planning questions".to_owned(),
            humanize(&draft.question_policy),
            String::new(),
        ),
    ];
    fields.extend(draft.intake_fields.iter().map(|field| {
        (
            format!(
                "{}{} [{}]",
                field.label,
                if field.required { "*" } else { "" },
                field.field_type
            ),
            field.value.clone(),
            if field.options.is_empty() {
                field.description.clone()
            } else {
                format!(
                    "{} options: {}",
                    field.description,
                    field
                        .options
                        .iter()
                        .map(|option| option.label.as_str())
                        .collect::<Vec<_>>()
                        .join(" | ")
                )
            },
        )
    }));
    let metadata_rows = u16::try_from(lines.len())
        .unwrap_or(u16::MAX)
        .saturating_sub(1_u16.saturating_add(chip_rows));
    let field_rows = area
        .height
        .saturating_sub(2)
        .saturating_sub(1_u16.saturating_add(chip_rows))
        .saturating_sub(metadata_rows)
        .saturating_sub(3)
        .max(2);
    let field_window = new_run_field_window(draft, fields.len(), field_rows);
    if field_window.is_paged() {
        lines.push(Line::styled(
            short(
                &format!(
                    "Details · showing {}–{} of {}",
                    field_window.start + 1,
                    field_window.end,
                    field_window.total
                ),
                usize::from(inner_width),
            ),
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.extend(
        fields[field_window.start..field_window.end]
            .iter()
            .enumerate()
            .flat_map(|(visible_index, (label, value, description))| {
                let field_index = field_window.start + visible_index;
                let index = field_index + 1;
                let selected = index == draft.active_field;
                let mut rows = vec![
                    Line::styled(
                        short(label, usize::from(inner_width)),
                        Style::default()
                            .fg(if selected {
                                Color::Cyan
                            } else {
                                Color::DarkGray
                            })
                            .add_modifier(Modifier::BOLD),
                    ),
                    Line::styled(
                        short(
                            &format!("{}{}", if selected { "▸ " } else { "  " }, value),
                            usize::from(inner_width),
                        ),
                        if selected {
                            Style::default().bg(Color::DarkGray)
                        } else {
                            Style::default()
                        },
                    ),
                ];
                if selected && !description.is_empty() {
                    rows.push(Line::styled(
                        short(&format!("  {description}"), usize::from(inner_width)),
                        Style::default().fg(Color::DarkGray),
                    ));
                }
                rows
            }),
    );
    lines.extend([
        Line::raw(""),
        Line::styled(
            short(
                if draft.submitted {
                    "Planning agent is running; the run remains durable after this view closes."
                } else {
                    "A permanent branch is created only after plan approval."
                },
                usize::from(inner_width),
            ),
            Style::default().fg(Color::Yellow),
        ),
    ]);
    let controls = if draft.submitted {
        "Esc close"
    } else if draft.active_field == 0 {
        "←/→ or [/] or Home/End select · click select · Enter continue · Esc cancel"
    } else {
        "Enter next/start planning · ←/→ or [/] change · Esc cancel"
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" New run · guided intake ")
                    .title_bottom(control_tip(controls)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

const NEW_RUN_AGENT_ROLES: [(&str, &str); 4] = [
    ("planner", "Planner"),
    ("lead", "Lead"),
    ("ticket_worker", "Worker"),
    ("reviewer", "Reviewer"),
];

#[derive(Debug, Clone, Copy)]
struct NewRunControlIndices {
    target: usize,
    run_type: usize,
    questions: usize,
    parallel: usize,
    agents: usize,
    submit: usize,
}

fn new_run_control_indices(draft: &NewRunDraft) -> NewRunControlIndices {
    let target = 1 + draft.intake_fields.len();
    let run_type = target + 1;
    let questions = run_type + 1;
    let parallel = questions + 1;
    let agents = parallel + 1;
    NewRunControlIndices {
        target,
        run_type,
        questions,
        parallel,
        agents,
        submit: agents + NEW_RUN_AGENT_ROLES.len() * 2,
    }
}

fn target_branch_line(draft: &NewRunDraft, focused: bool, width: u16) -> Line<'static> {
    let candidate = draft
        .target_branches
        .iter()
        .find(|branch| branch.reference == draft.target_branch);
    let branch = candidate
        .map(|branch| branch.name.as_str())
        .or_else(|| draft.target_branch.strip_prefix("refs/heads/"))
        .unwrap_or(draft.target_branch.as_str());
    let suffix = candidate
        .filter(|branch| branch.checked_out)
        .map(|_| "  checked out")
        .unwrap_or_default();
    let badge = format!("  ◀  {branch}  ▶  ");
    let available = usize::from(width).saturating_sub(2 + CONFIG_CONTROL_LABEL_WIDTH);
    Line::from(vec![
        Span::styled(
            if focused { "▸ " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(
            format!("{:<CONFIG_CONTROL_LABEL_WIDTH$}", "Target branch"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            short(&badge, available.saturating_sub(suffix.chars().count())),
            if focused {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::White).bg(Color::DarkGray)
            },
        ),
        Span::styled(suffix, Style::default().fg(Color::DarkGray)),
    ])
}

fn section_divider(title: &str, width: u16) -> Line<'static> {
    let title_width = title.chars().count().saturating_add(2);
    let rule_width = usize::from(width).saturating_sub(title_width);
    let left = rule_width / 2;
    let right = rule_width.saturating_sub(left);
    Line::from(vec![
        Span::styled("─".repeat(left), Style::default().fg(Color::DarkGray)),
        Span::styled(
            format!(" {title} "),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("─".repeat(right), Style::default().fg(Color::DarkGray)),
    ])
}

const QUESTION_POLICIES: [(&str, &str, Color); 3] = [
    ("autonomous", "no", Color::Rgb(112, 148, 214)),
    ("high_impact_only", "some", Color::Rgb(92, 181, 201)),
    ("interactive", "many", Color::Rgb(174, 126, 211)),
];

fn question_policy_chips(policy: &str, focused: bool) -> Line<'static> {
    let mut spans = vec![
        Span::styled(
            if focused { "▸ " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(
            format!("{:<CONFIG_CONTROL_LABEL_WIDTH$}", "Questions"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    for (index, (value, label, color)) in QUESTION_POLICIES.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw(" "));
        }
        let selected = policy == *value;
        spans.push(Span::styled(
            format!("  {label}  "),
            if selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(*color)
                    .add_modifier(if focused {
                        Modifier::BOLD | Modifier::UNDERLINED
                    } else {
                        Modifier::BOLD
                    })
            } else {
                Style::default()
                    // Keep each policy's identity color visible while making
                    // its inactive state quieter than the selected chip.
                    .fg(*color)
                    .bg(Color::Rgb(32, 36, 40))
                    .add_modifier(Modifier::DIM)
            },
        ));
    }
    Line::from(spans)
}

fn question_policy_badge_ranges(width: u16) -> Vec<(&'static str, BadgeRange)> {
    let mut start = u16::try_from(2 + CONFIG_CONTROL_LABEL_WIDTH).unwrap_or(u16::MAX);
    QUESTION_POLICIES
        .iter()
        .map(|(policy, label, _)| {
            let badge_width = u16::try_from(label.chars().count().saturating_add(4))
                .unwrap_or(u16::MAX)
                .min(width.saturating_sub(start));
            let range = BadgeRange {
                start,
                width: badge_width,
            };
            start = start.saturating_add(badge_width).saturating_add(1);
            (*policy, range)
        })
        .collect()
}

fn canonical_workflow_stages(run_types: &[RunTypeOption]) -> Vec<crate::model::RunStageOption> {
    let mut type_order = (0..run_types.len()).collect::<Vec<_>>();
    type_order.sort_by_key(|index| (std::cmp::Reverse(run_types[*index].stages.len()), *index));

    let mut stages = std::collections::BTreeMap::new();
    let mut first_seen = std::collections::BTreeMap::new();
    let mut successors =
        std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
    let mut next_ordinal = 0_usize;
    for index in type_order {
        for stage in &run_types[index].stages {
            stages
                .entry(stage.id.clone())
                .or_insert_with(|| stage.clone());
            first_seen.entry(stage.id.clone()).or_insert_with(|| {
                let ordinal = next_ordinal;
                next_ordinal += 1;
                ordinal
            });
            successors.entry(stage.id.clone()).or_default();
        }
        for pair in run_types[index].stages.windows(2) {
            successors
                .entry(pair[0].id.clone())
                .or_default()
                .insert(pair[1].id.clone());
        }
    }

    let mut indegree = stages
        .keys()
        .map(|id| (id.clone(), 0_usize))
        .collect::<std::collections::BTreeMap<_, _>>();
    for targets in successors.values() {
        for target in targets {
            if let Some(count) = indegree.get_mut(target) {
                *count += 1;
            }
        }
    }

    let mut ordered = Vec::<String>::with_capacity(stages.len());
    while ordered.len() < stages.len() {
        let next = indegree
            .iter()
            .filter(|(id, count)| **count == 0 && !ordered.contains(*id))
            .min_by_key(|(id, _)| (first_seen.get(*id).copied().unwrap_or(usize::MAX), *id))
            .map(|(id, _)| id.clone());
        let Some(next) = next else {
            // Independently valid run types can disagree about the relative
            // order of shared stage IDs. Keep the preview deterministic even
            // when their combined display constraints form a cycle.
            let mut remaining = stages
                .keys()
                .filter(|id| !ordered.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            remaining.sort_by_key(|id| {
                (
                    first_seen.get(id).copied().unwrap_or(usize::MAX),
                    id.clone(),
                )
            });
            ordered.extend(remaining);
            break;
        };
        ordered.push(next.clone());
        if let Some(targets) = successors.get(&next) {
            for target in targets {
                if let Some(count) = indegree.get_mut(target) {
                    *count = count.saturating_sub(1);
                }
            }
        }
    }

    ordered
        .into_iter()
        .filter_map(|id| stages.remove(&id))
        .collect()
}

fn wrap_full_text(value: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in value.split_whitespace() {
        let next_width = current
            .chars()
            .count()
            .saturating_add(usize::from(!current.is_empty()))
            .saturating_add(word.chars().count());
        if !current.is_empty() && next_width > width {
            lines.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn workflow_stage_rows(
    run_types: &[RunTypeOption],
    selected_run_type: &str,
    width: u16,
) -> Vec<Vec<Line<'static>>> {
    let selected = run_types
        .iter()
        .find(|run_type| run_type.id == selected_run_type);
    let canonical = canonical_workflow_stages(run_types);
    if canonical.is_empty() {
        return vec![vec![Line::styled(
            "  ○ No configured stages",
            Style::default().fg(Color::DarkGray),
        )]];
    }
    // Keep wrapping stable across every supported terminal width so the draft
    // can own a row offset without coupling keyboard handling to a particular
    // render frame. Fifty-nine columns is the title budget at the documented
    // 82-column minimum; roomier dialogs retain that readable line length.
    const STAGE_TITLE_WIDTH: usize = 59;
    let title_width = usize::from(width)
        .saturating_sub(17)
        .clamp(1, STAGE_TITLE_WIDTH);
    canonical
        .iter()
        .enumerate()
        .map(|(index, canonical_stage)| {
            let selected_stage = selected.and_then(|run_type| {
                run_type
                    .stages
                    .iter()
                    .find(|stage| stage.id == canonical_stage.id)
            });
            let enabled = selected_stage.is_some();
            // A shared stage can deliberately have profile-specific wording.
            // The run badge is the workflow choice, so its title is authoritative.
            let title = selected_stage
                .map(|stage| stage.title.as_str())
                .unwrap_or(canonical_stage.title.as_str());
            wrap_full_text(title, title_width)
                .into_iter()
                .enumerate()
                .map(|(line_index, title)| {
                    let mut spans = if line_index == 0 {
                        vec![
                            Span::styled(
                                format!("  {:>2}  ", index + 1),
                                Style::default().fg(Color::DarkGray),
                            ),
                            Span::styled(
                                if enabled { "● " } else { "○ " },
                                Style::default().fg(if enabled {
                                    Color::Cyan
                                } else {
                                    Color::DarkGray
                                }),
                            ),
                        ]
                    } else {
                        vec![Span::raw("        ")]
                    };
                    spans.push(Span::styled(
                        title,
                        Style::default().fg(if enabled {
                            Color::White
                        } else {
                            Color::DarkGray
                        }),
                    ));
                    if !enabled && line_index == 0 {
                        spans.push(Span::styled(
                            "  skipped",
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::ITALIC),
                        ));
                    }
                    Line::from(spans)
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[derive(Debug, Clone)]
struct WorkflowStageWindow {
    lines: Vec<Line<'static>>,
    first_stage: usize,
    end_stage: usize,
}

fn workflow_stage_window(
    stages: &[Vec<Line<'static>>],
    requested_first_line: usize,
    capacity: usize,
) -> WorkflowStageWindow {
    if stages.is_empty() || capacity == 0 {
        return WorkflowStageWindow {
            lines: Vec::new(),
            first_stage: 0,
            end_stage: 0,
        };
    }
    let flattened = stages
        .iter()
        .enumerate()
        .flat_map(|(stage_index, lines)| lines.iter().cloned().map(move |line| (stage_index, line)))
        .collect::<Vec<_>>();
    let first_line = requested_first_line.min(flattened.len().saturating_sub(1));
    let visible = flattened
        .iter()
        .skip(first_line)
        .take(capacity)
        .cloned()
        .collect::<Vec<_>>();
    let first_stage = visible.first().map_or(0, |(stage, _)| *stage);
    let end_stage = visible
        .last()
        .map_or(first_stage, |(stage, _)| stage.saturating_add(1));
    WorkflowStageWindow {
        lines: visible.into_iter().map(|(_, line)| line).collect(),
        first_stage,
        end_stage,
    }
}

pub(crate) fn new_run_stage_line_count(
    run_types: &[RunTypeOption],
    selected_run_type: &str,
) -> usize {
    // 76 = the New Run inner width at the supported 82-column minimum.
    workflow_stage_rows(run_types, selected_run_type, 76)
        .iter()
        .map(Vec::len)
        .sum()
}

const CONFIG_CONTROL_LABEL_WIDTH: usize = 22;
const AGENT_ROLE_WIDTH: usize = 14;
const AGENT_MODEL_COLUMN_WIDTH: usize = 34;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BadgeRange {
    start: u16,
    width: u16,
}

fn config_selector_badge_range(value: &str, width: u16) -> BadgeRange {
    let start = u16::try_from(2 + CONFIG_CONTROL_LABEL_WIDTH).unwrap_or(u16::MAX);
    BadgeRange {
        start,
        width: u16::try_from(value.chars().count().saturating_add(2))
            .unwrap_or(u16::MAX)
            .min(width.saturating_sub(start)),
    }
}

fn parallelism_line(value: usize, focused: bool) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            if focused { "▸ " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(
            format!("{:<CONFIG_CONTROL_LABEL_WIDTH$}", "Max parallel agents"),
            Style::default().fg(Color::White),
        ),
        Span::styled(
            format!(" −  {value}  + "),
            Style::default()
                .fg(Color::Black)
                .bg(Color::LightBlue)
                .add_modifier(if focused {
                    Modifier::BOLD | Modifier::UNDERLINED
                } else {
                    Modifier::BOLD
                }),
        ),
    ])
}

fn parallelism_badge_range(value: usize, width: u16) -> BadgeRange {
    config_selector_badge_range(&format!("−  {value}  +"), width)
}

fn agent_setting_values(setting: Option<&crate::model::RunAgentSetting>) -> (&str, &str) {
    let model = setting
        .and_then(|setting| setting.model.as_deref())
        .unwrap_or("Codex default");
    let reasoning = setting
        .and_then(|setting| setting.reasoning_effort.as_deref())
        .unwrap_or("Codex default");
    (model, reasoning)
}

fn agent_selector_badge_ranges(
    setting: Option<&crate::model::RunAgentSetting>,
    width: u16,
) -> (BadgeRange, BadgeRange) {
    let (model, reasoning) = agent_setting_values(setting);
    let model = short(model, 24);
    let reasoning = short(reasoning, 14);
    let model_start = u16::try_from(2 + AGENT_ROLE_WIDTH).unwrap_or(u16::MAX);
    let model_range = BadgeRange {
        start: model_start,
        width: u16::try_from(model.chars().count().saturating_add(2))
            .unwrap_or(u16::MAX)
            .min(width.saturating_sub(model_start)),
    };
    let reasoning_start =
        u16::try_from(2 + AGENT_ROLE_WIDTH + AGENT_MODEL_COLUMN_WIDTH).unwrap_or(u16::MAX);
    let reasoning_range = BadgeRange {
        start: reasoning_start,
        width: u16::try_from(reasoning.chars().count().saturating_add(2))
            .unwrap_or(u16::MAX)
            .min(width.saturating_sub(reasoning_start)),
    };
    (model_range, reasoning_range)
}

fn agent_table_header_line() -> Line<'static> {
    Line::from(vec![
        Span::raw("  "),
        Span::styled(
            format!("{:<AGENT_ROLE_WIDTH$}", "Agent"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{:<AGENT_MODEL_COLUMN_WIDTH$}", "Model"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "Reasoning",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn stable_model_color(model: &str) -> Color {
    match model {
        "Codex default" => return Color::Rgb(132, 142, 158),
        "gpt-5.5" => return Color::Rgb(112, 158, 222),
        "gpt-5.6-sol" => return Color::Rgb(121, 185, 204),
        "gpt-5.6-terra" => return Color::Rgb(177, 132, 214),
        "gpt-5.6-luna" => return Color::Rgb(111, 199, 190),
        "gpt-5.4" => return Color::Rgb(151, 145, 218),
        "gpt-5.4-mini" => return Color::Rgb(197, 131, 197),
        "gpt-5.3-codex-spark" => return Color::Rgb(101, 181, 224),
        _ => {}
    }
    let hash = model.bytes().fold(2_166_136_261_usize, |hash, byte| {
        hash.wrapping_mul(16_777_619) ^ usize::from(byte)
    });
    // Dynamic catalogs can introduce models we did not know at compile time.
    // Keep their identity colors in a cool categorical palette so ordinary
    // model choices never borrow the red/green semantics reserved for state.
    let channel = |shift: usize, floor: u8, range: u8| {
        let value = u8::try_from((hash >> shift) & 0xff).unwrap_or_default();
        floor.saturating_add(value % range)
    };
    Color::Rgb(
        channel(0, 92, 104),
        channel(8, 126, 84),
        channel(16, 178, 70),
    )
}

fn stable_reasoning_color(reasoning: &str) -> Color {
    const AXIS: [Color; 8] = [
        Color::Rgb(218, 202, 210),
        Color::Rgb(222, 191, 207),
        Color::Rgb(226, 180, 204),
        Color::Rgb(230, 165, 199),
        Color::Rgb(234, 148, 193),
        Color::Rgb(238, 128, 187),
        Color::Rgb(242, 105, 179),
        Color::Rgb(246, 80, 170),
    ];
    let index = match reasoning {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        "max" => 6,
        "ultra" => 7,
        "Codex default" => return Color::Rgb(210, 198, 204),
        other => {
            let hash = other.bytes().fold(2_166_136_261_usize, |hash, byte| {
                hash.wrapping_mul(16_777_619) ^ usize::from(byte)
            });
            hash % AXIS.len()
        }
    };
    AXIS[index]
}

fn identity_badge(value: &str, color: Color, focused: bool) -> Span<'static> {
    Span::styled(
        format!(" {value} "),
        Style::default()
            .fg(if color == Color::DarkGray {
                Color::White
            } else {
                Color::Black
            })
            .bg(color)
            .add_modifier(if focused {
                Modifier::BOLD | Modifier::UNDERLINED
            } else {
                Modifier::BOLD
            }),
    )
}

fn agent_selector_line(
    label: &str,
    setting: Option<&crate::model::RunAgentSetting>,
    model_focused: bool,
    reasoning_focused: bool,
) -> Line<'static> {
    let (model, reasoning) = agent_setting_values(setting);
    let model = short(model, 24);
    let reasoning = short(reasoning, 14);
    let model_badge = identity_badge(&model, stable_model_color(&model), model_focused);
    let model_padding =
        AGENT_MODEL_COLUMN_WIDTH.saturating_sub(model.chars().count().saturating_add(2));
    Line::from(vec![
        Span::styled(
            if model_focused || reasoning_focused {
                "▸ "
            } else {
                "  "
            },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(
            format!("{label:<AGENT_ROLE_WIDTH$}"),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        model_badge,
        Span::raw(" ".repeat(model_padding)),
        identity_badge(
            &reasoning,
            stable_reasoning_color(&reasoning),
            reasoning_focused,
        ),
    ])
}

fn objective_editor_lines(
    draft: &NewRunDraft,
    width: u16,
    height: u16,
    focused: bool,
) -> Vec<Line<'static>> {
    let editor_width = usize::from(width.saturating_sub(2).max(1));
    let value_style = if focused {
        Style::default().fg(Color::White).bg(Color::DarkGray)
    } else {
        Style::default().fg(Color::Gray)
    };
    let caret_style = Style::default()
        .fg(Color::Black)
        .bg(Color::Cyan)
        .add_modifier(Modifier::BOLD);
    let mut wrapped = if draft.goal.is_empty() && !focused {
        vec![Line::styled("—", value_style)]
    } else {
        multiline_editor_value_lines(
            &draft.goal,
            focused.then_some(draft.objective_cursor),
            editor_width,
            value_style,
            caret_style,
        )
    };
    if wrapped.is_empty() {
        wrapped.push(Line::raw(""));
    }

    let visible_rows = usize::from(height.max(1));
    let caret_row = wrapped
        .iter()
        .position(|line| line.spans.iter().any(|span| span.style == caret_style));
    let max_start = wrapped.len().saturating_sub(visible_rows);
    let start = caret_row
        .map_or(0, |row| row.saturating_sub(visible_rows - 1))
        .min(max_start);
    let mut output = Vec::with_capacity(visible_rows);
    for visible_index in 0..visible_rows {
        let source_index = start + visible_index;
        let prefix = if focused && visible_index == 0 {
            "▸ "
        } else {
            "  "
        };
        let mut spans = vec![Span::styled(
            prefix,
            Style::default().fg(if focused {
                Color::Cyan
            } else {
                Color::DarkGray
            }),
        )];
        if let Some(line) = wrapped.get(source_index) {
            spans.extend(line.spans.clone());
        }
        output.push(Line::from(spans));
    }
    output
}

fn draw_new_run_dialog(
    frame: &mut Frame<'_>,
    area: Rect,
    draft: &NewRunDraft,
    run_types: &[RunTypeOption],
) {
    let width = area.width.saturating_sub(2).max(1);
    let inner_height = area.height.saturating_sub(2);
    let indices = new_run_control_indices(draft);
    let (chips, window) = run_type_chip_page(draft, run_types, width, area.height);
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let chips_inline = !window.is_paged() && run_type_layout_fits_inline(&chips, width);
    let chip_extra_rows = if chips_inline { 0 } else { chip_rows };
    let stage_groups = workflow_stage_rows(run_types, &draft.run_type, width);
    let gap = new_run_section_gap(area.height);
    let objective_rows = new_run_objective_rows(area.height);
    // At compact terminal sizes, preserve every interactive control and use
    // the remaining rows for the ordered stage preview. A taller terminal
    // naturally expands this window until every full stage title is shown.
    let prompt_total = 1 + draft.intake_fields.len();
    let active_prompt = draft.active_field.min(prompt_total.saturating_sub(1));
    let stage_capacity = usize::from(
        inner_height.saturating_sub(
            15_u16
                .saturating_add(gap.saturating_mul(5))
                .saturating_add(chip_extra_rows)
                .saturating_add(new_run_prompt_row_height(active_prompt, objective_rows)),
        ),
    );
    let stage_window = workflow_stage_window(&stage_groups, draft.stage_scroll, stage_capacity);
    let visible_stage_lines = stage_window.lines;
    let first_visible_stage = stage_window.first_stage;
    let end_visible_stage = stage_window.end_stage;
    let fixed_rows = 15_u16
        .saturating_add(gap.saturating_mul(5))
        .saturating_add(chip_extra_rows)
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX));
    let (prompt_start, prompt_end, _) = new_run_prompt_window(
        draft,
        inner_height.saturating_sub(fixed_rows),
        objective_rows,
    );

    let mut lines = vec![section_divider("Objective", width)];
    for prompt_index in prompt_start..prompt_end {
        let focused = draft.active_field == prompt_index;
        if prompt_index == 0 {
            lines.extend(objective_editor_lines(
                draft,
                width,
                objective_rows,
                focused,
            ));
            continue;
        }
        let (label, value, required) = {
            let field = &draft.intake_fields[prompt_index - 1];
            (field.label.as_str(), field.value.as_str(), field.required)
        };
        lines.push(Line::styled(
            short(
                &format!(
                    "{}{}{}",
                    if focused { "▸ " } else { "  " },
                    label,
                    if required { " *" } else { "" }
                ),
                usize::from(width),
            ),
            Style::default()
                .fg(if focused {
                    Color::Cyan
                } else {
                    Color::DarkGray
                })
                .add_modifier(Modifier::BOLD),
        ));
        let input = if value.is_empty() {
            if focused {
                "  ▏".to_owned()
            } else {
                "  —".to_owned()
            }
        } else {
            short(&format!("  {value}"), usize::from(width))
        };
        lines.push(Line::styled(
            input,
            if focused {
                Style::default().bg(Color::DarkGray)
            } else {
                Style::default()
            },
        ));
    }

    lines.push(section_divider("Run Config", width));
    lines.push(target_branch_line(
        draft,
        draft.active_field == indices.target,
        width,
    ));
    if gap > 0 {
        lines.push(Line::raw(""));
    }
    if !chips_inline {
        lines.push(Line::from(vec![
            Span::styled(
                if draft.active_field == indices.run_type {
                    "▸ "
                } else {
                    "  "
                },
                Style::default().fg(Color::Cyan),
            ),
            Span::styled(
                selector_heading(
                    "Run type",
                    chips.iter().map(|chip| chip.index),
                    run_types.len(),
                    window,
                ),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
    }
    for row in 0..chip_rows {
        let mut spans = if chips_inline {
            vec![
                Span::styled(
                    if draft.active_field == indices.run_type {
                        "▸ "
                    } else {
                        "  "
                    },
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    format!("{:<CONFIG_CONTROL_LABEL_WIDTH$}", "Run type"),
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
            ]
        } else {
            Vec::new()
        };
        let prefix = if chips_inline {
            u16::try_from(2 + CONFIG_CONTROL_LABEL_WIDTH).unwrap_or(u16::MAX)
        } else {
            0
        };
        let mut cursor = prefix;
        for chip in chips.iter().filter(|chip| chip.row == row) {
            let chip_x = prefix.saturating_add(chip.x);
            if chip_x > cursor {
                spans.push(Span::raw(" ".repeat(usize::from(chip_x - cursor))));
            }
            let run_type = &run_types[chip.index];
            let selected = run_type.id == draft.run_type;
            let label_width = usize::from(chip.width.saturating_sub(4));
            spans.push(Span::styled(
                format!("  {:<label_width$}  ", short(&run_type.title, label_width)),
                if selected {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White).bg(Color::DarkGray)
                },
            ));
            cursor = chip_x.saturating_add(chip.width);
        }
        lines.push(Line::from(spans));
    }

    if gap > 0 {
        lines.push(Line::raw(""));
    }

    let stage_heading = if first_visible_stage > 0 || end_visible_stage < stage_groups.len() {
        format!(
            "Stages · {}–{} of {} · PgUp/PgDn",
            first_visible_stage.saturating_add(1),
            end_visible_stage.max(first_visible_stage.saturating_add(1)),
            stage_groups.len()
        )
    } else {
        "Stages".to_owned()
    };
    lines.push(Line::styled(
        stage_heading,
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    ));
    lines.extend(visible_stage_lines);
    if gap > 0 {
        lines.push(Line::raw(""));
    }
    lines.push(question_policy_chips(
        &draft.question_policy,
        draft.active_field == indices.questions,
    ));
    if gap > 0 {
        lines.push(Line::raw(""));
    }
    lines.push(parallelism_line(
        draft.max_parallel,
        draft.active_field == indices.parallel,
    ));
    if gap > 0 {
        lines.push(Line::raw(""));
    }
    lines.push(agent_table_header_line());
    for (offset, (role, label)) in NEW_RUN_AGENT_ROLES.iter().enumerate() {
        let model_field = indices.agents + offset * 2;
        lines.push(agent_selector_line(
            label,
            draft.agent_roles.get(*role),
            draft.active_field == model_field,
            draft.active_field == model_field + 1,
        ));
    }
    lines.push(Line::styled(
        "─".repeat(usize::from(width)),
        Style::default().fg(Color::DarkGray),
    ));

    let selected_workflow = run_types
        .iter()
        .find(|run_type| run_type.id == draft.run_type);
    let button_label = if selected_workflow.is_some_and(|run_type| run_type.planning_passes == 0) {
        "Start Work"
    } else {
        "Start Planning"
    };
    let button_focused = draft.active_field == indices.submit;
    lines.push(
        Line::from(Span::styled(
            format!("  {button_label}  "),
            if button_focused {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Cyan).bg(Color::DarkGray)
            },
        ))
        .alignment(Alignment::Center),
    );
    let footer = if draft.active_field == 0 {
        "Enter newline · arrows/Home/End · Backspace/Delete · Tab next · Esc"
    } else {
        "Tab/↑↓/jk move · ←→/[] change · Enter activates control · Esc cancels"
    };
    lines.truncate(usize::from(inner_height));
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .title(" New run ")
                .title_bottom(control_tip(footer)),
        ),
        area,
    );
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NewRunHit {
    Field(usize),
    RunType(String),
    QuestionPolicy(String),
    ParallelDelta(isize),
}

pub(crate) fn new_run_hit_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    size: ratatui::layout::Size,
) -> Option<NewRunHit> {
    let Dialog::NewRun(draft) = model.dialog.as_ref()? else {
        return None;
    };
    let area = new_run_dialog_area(
        Rect::new(0, 0, size.width, size.height),
        draft,
        &model.run_types,
    );
    let (chips, window) = run_type_chip_page(
        draft,
        &model.run_types,
        area.width.saturating_sub(2).max(1),
        area.height,
    );
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let inner_height = area.height.saturating_sub(2);
    let width = area.width.saturating_sub(2).max(1);
    let chips_inline = !window.is_paged() && run_type_layout_fits_inline(&chips, width);
    let chip_extra_rows = if chips_inline { 0 } else { chip_rows };
    let stage_groups = workflow_stage_rows(&model.run_types, &draft.run_type, width);
    let gap = new_run_section_gap(area.height);
    let objective_rows = new_run_objective_rows(area.height);
    let prompt_total = 1 + draft.intake_fields.len();
    let active_prompt = draft.active_field.min(prompt_total.saturating_sub(1));
    let stage_capacity = usize::from(
        inner_height.saturating_sub(
            15_u16
                .saturating_add(gap.saturating_mul(5))
                .saturating_add(chip_extra_rows)
                .saturating_add(new_run_prompt_row_height(active_prompt, objective_rows)),
        ),
    );
    let visible_stage_lines =
        workflow_stage_window(&stage_groups, draft.stage_scroll, stage_capacity).lines;
    let fixed_rows = 15_u16
        .saturating_add(gap.saturating_mul(5))
        .saturating_add(chip_extra_rows)
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX));
    let (prompt_start, prompt_end, prompt_rows) = new_run_prompt_window(
        draft,
        inner_height.saturating_sub(fixed_rows),
        objective_rows,
    );
    let inner_y = area.y.saturating_add(1);
    let prompt_y = inner_y.saturating_add(1);
    let mut field_y = prompt_y;
    for index in prompt_start..prompt_end {
        let height = new_run_prompt_row_height(index, objective_rows);
        if row >= field_y && row < field_y.saturating_add(height) {
            return Some(NewRunHit::Field(index));
        }
        field_y = field_y.saturating_add(height);
    }
    let target_selector_y = inner_y.saturating_add(2).saturating_add(prompt_rows);
    let run_selector_y = target_selector_y.saturating_add(1).saturating_add(gap);
    let chip_y = if chips_inline {
        run_selector_y
    } else {
        run_selector_y.saturating_add(1)
    };
    let chip_prefix = if chips_inline {
        u16::try_from(2 + CONFIG_CONTROL_LABEL_WIDTH).unwrap_or(u16::MAX)
    } else {
        0
    };
    if let Some(id) = chips.into_iter().find_map(|chip| {
        let x = area
            .x
            .saturating_add(1)
            .saturating_add(chip_prefix)
            .saturating_add(chip.x);
        let y = chip_y.saturating_add(chip.row);
        (column >= x && column < x.saturating_add(chip.width) && row == y)
            .then(|| model.run_types[chip.index].id.clone())
    }) {
        return Some(NewRunHit::RunType(id));
    }
    let indices = new_run_control_indices(draft);
    if row == target_selector_y {
        return Some(NewRunHit::Field(indices.target));
    }
    if row == run_selector_y {
        return Some(NewRunHit::Field(indices.run_type));
    }
    let run_type_rows = 1_u16.saturating_add(chip_extra_rows);
    let stage_y = run_selector_y
        .saturating_add(run_type_rows)
        .saturating_add(gap)
        .saturating_add(1);
    let questions_y = stage_y
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX))
        .saturating_add(gap);
    let parallel_y = questions_y.saturating_add(1).saturating_add(gap);
    let agents_header_y = parallel_y.saturating_add(1).saturating_add(gap);
    let agents_y = agents_header_y.saturating_add(1);
    let inner_x = area.x.saturating_add(1);
    if column < inner_x || column >= inner_x.saturating_add(width) {
        return None;
    }
    let local_column = column.saturating_sub(inner_x);
    let in_range = |range: BadgeRange| {
        local_column >= range.start && local_column < range.start.saturating_add(range.width)
    };
    if row == questions_y {
        if let Some((policy, _)) = question_policy_badge_ranges(width)
            .into_iter()
            .find(|(_, range)| in_range(*range))
        {
            return Some(NewRunHit::QuestionPolicy(policy.to_owned()));
        }
        return Some(NewRunHit::Field(indices.questions));
    }
    if row == parallel_y {
        let range = parallelism_badge_range(draft.max_parallel, width);
        if in_range(range) {
            if local_column < range.start.saturating_add(3) {
                return Some(NewRunHit::ParallelDelta(-1));
            }
            if local_column >= range.start.saturating_add(range.width).saturating_sub(3) {
                return Some(NewRunHit::ParallelDelta(1));
            }
            return Some(NewRunHit::Field(indices.parallel));
        }
    }
    for (offset, (role, _)) in NEW_RUN_AGENT_ROLES.iter().enumerate() {
        if row != agents_y.saturating_add(u16::try_from(offset).unwrap_or(u16::MAX)) {
            continue;
        }
        let (model_range, reasoning_range) =
            agent_selector_badge_ranges(draft.agent_roles.get(*role), width);
        if in_range(model_range) {
            return Some(NewRunHit::Field(indices.agents + offset * 2));
        }
        if in_range(reasoning_range) {
            return Some(NewRunHit::Field(indices.agents + offset * 2 + 1));
        }
    }
    let submit_y = agents_y
        .saturating_add(u16::try_from(NEW_RUN_AGENT_ROLES.len()).unwrap_or(u16::MAX))
        .saturating_add(1);
    if row == submit_y {
        let button_label = if model
            .run_types
            .iter()
            .find(|run_type| run_type.id == draft.run_type)
            .is_some_and(|run_type| run_type.planning_passes == 0)
        {
            "Start Work"
        } else {
            "Start Planning"
        };
        let button_width = u16::try_from(button_label.chars().count().saturating_add(4))
            .unwrap_or(u16::MAX)
            .min(width);
        let button_start = width.saturating_sub(button_width) / 2;
        if local_column >= button_start && local_column < button_start.saturating_add(button_width)
        {
            return Some(NewRunHit::Field(indices.submit));
        }
    }
    None
}

#[cfg(test)]
pub(crate) fn new_run_type_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    size: ratatui::layout::Size,
) -> Option<String> {
    match new_run_hit_at(model, column, row, size) {
        Some(NewRunHit::RunType(id)) => Some(id),
        _ => None,
    }
}

fn centered_box(max_width: u16, max_height: u16, area: Rect) -> Rect {
    let width = area.width.saturating_sub(4).min(max_width);
    let height = area.height.saturating_sub(2).min(max_height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

fn edit_scalar_dialog_area(
    bounds: Rect,
    edit: &EditScalarDraft,
    resource: Option<&ConfigResource>,
) -> Rect {
    const MAX_WIDTH: u16 = 104;
    let width = bounds.width.saturating_sub(4).min(MAX_WIDTH);
    let inner_width = width.saturating_sub(2).max(1);
    let content_height = edit_scalar_dialog_lines(edit, usize::from(inner_width), resource).len();
    let height = u16::try_from(content_height)
        .unwrap_or(u16::MAX)
        .saturating_add(2);
    centered_box(MAX_WIDTH, height, bounds)
}

fn edit_scalar_controls() -> &'static str {
    "←→ · Home/End · Bksp/Del · type/paste at caret · Enter apply · Esc"
}

fn edit_scalar_dialog_lines(
    edit: &EditScalarDraft,
    width: usize,
    resource: Option<&ConfigResource>,
) -> Vec<Line<'static>> {
    let (context, field) = resource.map_or_else(
        || form_path_parts(&edit.path),
        |resource| semantic_form_parts(resource, &edit.path),
    );
    let mut lines = wrap_scalar_editor_text(&field, heading_style(), width);
    lines.extend(wrap_scalar_editor_text(
        &context,
        Style::default().fg(Color::DarkGray),
        width,
    ));
    if let Some(explanation) =
        resource.and_then(|resource| semantic_form_explanation(resource, &edit.path))
    {
        lines.extend(wrap_scalar_editor_text(
            explanation,
            Style::default().fg(Color::LightBlue),
            width,
        ));
    }
    lines.push(Line::raw(""));
    lines.extend(edit_scalar_value_lines(edit, width));
    lines
}

#[derive(Debug)]
struct ScalarEditorGlyph {
    text: String,
    width: usize,
    whitespace: bool,
    style: Style,
}

fn wrap_scalar_editor_text(value: &str, style: Style, width: usize) -> Vec<Line<'static>> {
    let logical_lines = value
        .split('\n')
        .map(|line| {
            line.chars()
                .map(|character| scalar_editor_glyph(character, style))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    wrap_scalar_editor_glyphs(logical_lines, width)
}

fn edit_scalar_value_lines(edit: &EditScalarDraft, width: usize) -> Vec<Line<'static>> {
    let value_style = Style::default()
        .fg(scalar_color(&edit.kind))
        .bg(Color::DarkGray);
    let caret_style = Style::default()
        .fg(Color::Black)
        .bg(Color::Cyan)
        .add_modifier(Modifier::BOLD);
    multiline_editor_value_lines(
        &edit.value,
        Some(edit.cursor),
        width,
        value_style,
        caret_style,
    )
}

fn multiline_editor_value_lines(
    value: &str,
    cursor: Option<usize>,
    width: usize,
    value_style: Style,
    caret_style: Style,
) -> Vec<Line<'static>> {
    let cursor = cursor.map(|cursor| cursor.min(value.chars().count()));
    let mut lines = Vec::new();
    let mut glyphs = Vec::new();
    let mut position = 0;
    for character in value.chars() {
        if cursor == Some(position) {
            glyphs.push(ScalarEditorGlyph {
                text: "▏".to_owned(),
                width: 1,
                whitespace: false,
                style: caret_style,
            });
        }
        if character == '\n' {
            lines.push(std::mem::take(&mut glyphs));
        } else {
            glyphs.push(scalar_editor_glyph(character, value_style));
        }
        position += 1;
    }
    if cursor == Some(position) {
        glyphs.push(ScalarEditorGlyph {
            text: "▏".to_owned(),
            width: 1,
            whitespace: false,
            style: caret_style,
        });
    }
    lines.push(glyphs);
    wrap_scalar_editor_glyphs(lines, width)
}

fn scalar_editor_glyph(character: char, style: Style) -> ScalarEditorGlyph {
    let (text, whitespace) = match character {
        '\t' => ("⇥".to_owned(), true),
        character if character.is_control() => ("�".to_owned(), false),
        character => (character.to_string(), character.is_whitespace()),
    };
    let width = UnicodeWidthStr::width(text.as_str());
    ScalarEditorGlyph {
        text,
        width,
        whitespace,
        style,
    }
}

fn wrap_scalar_editor_glyphs(
    logical_lines: Vec<Vec<ScalarEditorGlyph>>,
    width: usize,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut output = Vec::new();
    for mut remaining in logical_lines {
        if remaining.is_empty() {
            output.push(Line::raw(""));
            continue;
        }
        while !remaining.is_empty() {
            let mut used: usize = 0;
            let mut fit = 0;
            for glyph in &remaining {
                if fit > 0 && used.saturating_add(glyph.width) > width {
                    break;
                }
                used = used.saturating_add(glyph.width);
                fit += 1;
                if used >= width {
                    break;
                }
            }
            fit = fit.max(1).min(remaining.len());
            let word_break = remaining[..fit]
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, glyph)| (index > 0 && glyph.whitespace).then_some(index + 1));
            let take = if fit < remaining.len() {
                word_break.unwrap_or(fit)
            } else {
                fit
            };
            let row = remaining.drain(..take).collect::<Vec<_>>();
            output.push(scalar_editor_line(row));
        }
    }
    output
}

fn scalar_editor_line(glyphs: Vec<ScalarEditorGlyph>) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    for glyph in glyphs {
        if let Some(previous) = spans.last_mut()
            && previous.style == glyph.style
        {
            previous.content.to_mut().push_str(&glyph.text);
        } else {
            spans.push(Span::styled(glyph.text, glyph.style));
        }
    }
    Line::from(spans)
}

fn draw_header(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let mode = match model.mode {
        Mode::Operate => "OPERATE",
        Mode::Configure => "CONFIGURE",
    };
    let run = model
        .selected_run_data()
        .and_then(|run| run.summary.as_ref());
    let run_data = model.selected_run_data();
    let run_has_live_agent = run.is_some_and(|run| run.active_agents > 0);
    let run_is_planning = run.is_some_and(|run| run.status == "planning");
    let planning_questions = if run_is_planning {
        run.map_or(0, |run| run.open_questions)
    } else {
        0
    };
    let planning_ready_for_approval =
        run_is_planning && run_data.is_some_and(RunData::planning_is_ready_for_approval);
    let run_text = run.map(|run| {
        let completed = model
            .selected_run_data()
            .map(|data| {
                data.tickets
                    .iter()
                    .filter(|ticket| ticket_is_closed(ticket))
                    .count()
            })
            .unwrap_or_default();
        let status_marker = if run_has_live_agent {
            "⚙"
        } else {
            status_glyph(&run.status)
        };
        (
            format!("{} · ", model.display_run_type_title(run)),
            status_marker,
            format!(
                " {} · {completed}/{} tickets · {}",
                current_run_stage_label(run_data, run),
                run.ticket_count,
                compact_new_token_count(run.new_tokens)
            ),
        )
    });
    let location = if model.launch_root == model.root {
        format!("project:{} (initialized here)", model.root.display())
    } else {
        format!(
            "initialized:{} · project:{}",
            model.launch_root.display(),
            model.root.display()
        )
    };
    let mut location_spans = vec![
        Span::styled(
            " KONI ",
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {mode} "), Style::default().fg(Color::Cyan)),
        Span::raw(location),
    ];
    if model.catalog_error.is_some() {
        location_spans.extend([
            Span::raw("  "),
            Span::styled(
                " CONFIG INVALID ",
                Style::default()
                    .fg(Color::White)
                    .bg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
    }
    let mut run_spans = vec![Span::raw(" ")];
    if let Some((before_status, status_marker, after_status)) = run_text {
        run_spans.extend([
            Span::styled(before_status, Style::default().fg(Color::LightBlue)),
            Span::styled(
                status_marker,
                if run_has_live_agent {
                    live_activity_style(model)
                } else {
                    Style::default().fg(Color::LightBlue)
                },
            ),
            Span::styled(after_status, Style::default().fg(Color::LightBlue)),
        ]);
    } else {
        run_spans.push(Span::styled(
            "no run selected",
            Style::default().fg(Color::LightBlue),
        ));
    }
    if run_is_planning && let Some(progress) = run_data.and_then(RunData::planning_budget_progress)
    {
        run_spans.extend([
            Span::styled(" · plan ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!(
                    "{}/{} {}",
                    compact_token_count(progress.used).trim_end_matches(" tks"),
                    compact_token_count(progress.limit).trim_end_matches(" tks"),
                    progress.metric.label()
                ),
                Style::default().fg(if progress.synthesis_forced {
                    Color::Yellow
                } else {
                    Color::LightMagenta
                }),
            ),
        ]);
    }
    if planning_questions > 0 {
        run_spans.extend([
            Span::raw(" · "),
            Span::styled(
                format!("? {planning_questions} awaiting input"),
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
    } else if planning_ready_for_approval {
        run_spans.extend([
            Span::raw(" · "),
            Span::styled(
                "◇ awaiting approval · [v Review plan]",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
    }
    frame.render_widget(
        Paragraph::new(vec![Line::from(location_spans), Line::from(run_spans)])
            .block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn current_run_stage_label(run: Option<&RunData>, summary: &RunSummary) -> String {
    if summary.status == "planning" {
        return "Planning".to_owned();
    }
    run.and_then(|run| {
        run.stages.iter().find(|stage| {
            !matches!(
                stage.get("status").and_then(Value::as_str),
                Some("succeeded" | "skipped")
            )
        })
    })
    .map(|stage| pipeline_stage_category(stage.get("definition").unwrap_or(stage)).to_owned())
    .unwrap_or_else(|| humanize(&summary.status))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OperateLayout {
    pub runs: Rect,
    pub tickets: Rect,
    pub ticket_switcher: Rect,
    pub ticket_items: Rect,
    pub details: Rect,
    pub detail_switcher: Rect,
    pub pending_questions: Option<Rect>,
    pub active_agents: Rect,
    pub activity: Rect,
    pub graph: Rect,
}

fn bordered_switcher_and_body(area: Rect) -> (Rect, Rect) {
    let inner = Block::default().borders(Borders::ALL).inner(area);
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(inner);
    (parts[0], parts[1])
}

#[cfg(test)]
pub(crate) fn operate_layout(area: Rect) -> OperateLayout {
    operate_layout_with_questions(area, false)
}

pub(crate) fn operate_layout_with_questions(
    area: Rect,
    show_pending_questions: bool,
) -> OperateLayout {
    // Runs, Details, and Graph are peer control-center surfaces. Keeping them
    // equal prevents the graph from silently taking space from the document
    // the operator is currently reading.
    let peer_width = area.width / 3;
    let left_width = area.width.saturating_sub(peer_width.saturating_mul(2));
    let middle_width = peer_width;
    let right_width = area
        .width
        .saturating_sub(left_width)
        .saturating_sub(middle_width);
    let columns = [
        Rect::new(area.x, area.y, left_width, area.height),
        Rect::new(
            area.x.saturating_add(left_width),
            area.y,
            middle_width,
            area.height,
        ),
        Rect::new(
            area.x
                .saturating_add(left_width)
                .saturating_add(middle_width),
            area.y,
            right_width,
            area.height,
        ),
    ];
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(30),
            Constraint::Percentage(42),
            Constraint::Percentage(28),
        ])
        .split(columns[0]);
    let (ticket_switcher, ticket_items) = bordered_switcher_and_body(left[1]);
    let middle = if show_pending_questions {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(67), Constraint::Percentage(33)])
            .split(columns[1])
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(100), Constraint::Percentage(0)])
            .split(columns[1])
    };
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(8), Constraint::Min(5)])
        .split(columns[2]);
    // Details navigation lives in the panel's top border rather than consuming
    // a row from its scrollable document.
    let detail_switcher = Rect::new(
        middle[0].x.saturating_add(1),
        middle[0].y,
        middle[0].width.saturating_sub(2),
        1,
    );
    OperateLayout {
        runs: left[0],
        tickets: left[1],
        ticket_switcher,
        ticket_items,
        details: middle[0],
        detail_switcher,
        pending_questions: show_pending_questions.then_some(middle[1]),
        active_agents: left[2],
        activity: right[0],
        graph: right[1],
    }
}

fn draw_operate(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let layout =
        operate_layout_with_questions(area, !model.selected_pending_questions().is_empty());
    draw_runs(frame, model, layout.runs);
    draw_tickets(frame, model, layout.tickets);
    draw_details(frame, model, layout.details);
    if let Some(questions) = layout.pending_questions {
        draw_pending_questions(frame, model, questions);
    }
    draw_active_agents(frame, model, layout.active_agents);
    draw_recent_activity(frame, model, layout.activity);
    draw_graph(frame, model, layout.graph);
}

fn draw_pending_questions(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let questions = model.selected_pending_questions();
    let selected = model
        .selected_question
        .min(questions.len().saturating_sub(1));
    let position = if questions.is_empty() {
        "0 / 0".to_owned()
    } else {
        format!("{} / {}", selected + 1, questions.len())
    };
    let title = if area.width >= 60 {
        format!(" Questions · ‹ {position} › ")
    } else {
        format!(" Questions {}/{} ", selected + 1, questions.len())
    };
    let controls = "←→/[] · ↑↓/jk · Enter";
    let block =
        panel_block(&title, model.focus == Focus::Questions).title_bottom(control_tip(controls));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(question) = questions.get(selected) else {
        return;
    };
    let prompt = question
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or("A decision is needed");
    let width = usize::from(inner.width).max(1);
    let mut lines = wrap_full_text(prompt, width)
        .into_iter()
        .map(|line| {
            Line::styled(
                line,
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )
        })
        .collect::<Vec<_>>();
    if let Some(context) = question
        .get("context")
        .and_then(Value::as_str)
        .filter(|context| !context.trim().is_empty())
    {
        lines.extend(
            wrap_full_text(context, width)
                .into_iter()
                .map(|line| Line::styled(line, Style::default().fg(Color::DarkGray))),
        );
    }
    lines.push(Line::raw(""));
    let options = question_options(question);
    let allow_custom = question_allows_custom(question);
    let choice_count = options.len() + usize::from(allow_custom);
    let selected_option = model
        .selected_question_option
        .min(choice_count.saturating_sub(1));
    let choice_start = lines.len();
    let choices = question_choice_lines(&options, selected_option, allow_custom, width);
    let selected_line = choice_start + choices.selected_line;
    lines.extend(choices.lines);
    if question_answer_is_pending_resume(question) {
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            "✓ Answer recorded · planning will resume after this batch is complete",
            Style::default().fg(Color::Green),
        ));
    }
    let viewport = usize::from(inner.height).max(1);
    let scroll = selected_line.saturating_sub(viewport.saturating_sub(1));
    frame.render_widget(
        Paragraph::new(lines)
            .scroll((u16::try_from(scroll).unwrap_or(u16::MAX), 0))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

pub(crate) fn pending_question_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    area: Rect,
) -> Option<usize> {
    let inner = Block::default().borders(Borders::ALL).inner(area);
    if !rect_contains(inner, column, row) {
        return None;
    }
    let count = model.selected_pending_questions().len();
    (count > 0).then_some(model.selected_question.min(count - 1))
}

fn agent_first(model: &ControlCenterModel, inner: Rect, count: usize) -> usize {
    let visible = usize::from(inner.height).max(1);
    model
        .selected_agent
        .saturating_sub(visible.saturating_sub(1))
        .min(count.saturating_sub(visible))
}

pub(crate) fn agent_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    area: Rect,
) -> Option<usize> {
    let inner = Block::default().borders(Borders::ALL).inner(area);
    if !rect_contains(inner, column, row) {
        return None;
    }
    let count = model.selected_agent_summaries().len();
    let index = agent_first(model, inner, count) + usize::from(row.saturating_sub(inner.y));
    (index < count).then_some(index)
}

fn draw_active_agents(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let agents = model.selected_agent_summaries();
    let active = agents.iter().filter(|agent| agent.live).count();
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    let first = agent_first(model, inner, agents.len());
    let end = first
        .saturating_add(usize::from(inner.height))
        .min(agents.len());
    let range =
        (agents.len() > usize::from(inner.height)).then(|| format!(" · {}–{}", first + 1, end));
    let title = if area.width < 34 {
        format!(" Agents {active} / {} active", agents.len())
    } else {
        format!(
            " Agents · {active} / {} active{} ",
            agents.len(),
            range.as_deref().unwrap_or_default()
        )
    };
    let block = panel_block(&title, model.focus == Focus::Agents);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if agents.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::styled(
                "○ No agent history",
                Style::default().fg(Color::DarkGray),
            )),
            inner,
        );
        return;
    }
    let lines = agents
        .iter()
        .enumerate()
        .skip(first)
        .take(usize::from(inner.height))
        .map(|(index, agent)| {
            let selected = model.focus == Focus::Agents && index == model.selected_agent;
            let failed = matches!(
                agent.status.as_str(),
                "failed"
                    | "error"
                    | "timed_out"
                    | "exited_before_output"
                    | "incomplete"
                    | "changes_requested"
                    | "recovery_required"
                    | "supervision_failed"
            );
            let waiting = matches!(
                agent.status.as_str(),
                "waiting" | "pending" | "paused" | "blocked"
            );
            Line::from(vec![
                Span::styled(
                    if selected { "▸" } else { " " },
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    if agent.live {
                        "⚙ "
                    } else if failed {
                        "! "
                    } else if waiting {
                        "◐ "
                    } else {
                        "○ "
                    },
                    if agent.live {
                        live_activity_style(model)
                    } else if failed {
                        Style::default()
                            .fg(Color::LightRed)
                            .add_modifier(Modifier::DIM)
                    } else if waiting {
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::DIM)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
                Span::styled(
                    short(
                        &agent_panel_label(model.overview_subject, agent),
                        usize::from(inner.width).saturating_sub(3),
                    ),
                    if agent.live {
                        Style::default().fg(Color::White)
                    } else {
                        Style::default()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::DIM)
                    },
                ),
            ])
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn agent_panel_label(subject: OverviewSubject, agent: &crate::model::AgentSummary) -> String {
    let work_title_is_useful = !agent.title.eq_ignore_ascii_case(&agent.persona)
        && !matches!(
            agent.title.as_str(),
            "Current run work" | "Completed ticket work"
        );
    if subject == OverviewSubject::Run {
        if let Some(ticket) = agent.ticket_title.as_deref() {
            return format!("{ticket} · {}", agent.persona);
        }
        return if work_title_is_useful {
            format!("Run · {} · {}", agent.persona, agent.title)
        } else {
            format!("Run · {}", agent.persona)
        };
    }
    if work_title_is_useful {
        format!("{} · {}", agent.persona, agent.title)
    } else {
        agent.persona.clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivityTone {
    Added,
    Modified,
    Deleted,
    Compiler,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivityItem {
    at: String,
    text: String,
    tone: ActivityTone,
    count: usize,
}

fn draw_recent_activity(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let run = model.selected_run_data();
    let items = run.map(recent_activity_items).unwrap_or_default();
    let visible = usize::from(area.height.saturating_sub(2)).max(1);
    let first = model
        .activity_scroll
        .min(items.len().saturating_sub(visible));
    let title = recent_activity_title(run, area.width);
    let block = panel_block(&title, model.focus == Focus::Activity);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if items.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::styled(
                if run.is_some() {
                    "◇ No run activity yet"
                } else {
                    "◇ Select a run to inspect activity"
                },
                Style::default().fg(Color::DarkGray),
            )),
            inner,
        );
        return;
    }
    let lines = items
        .iter()
        .skip(first)
        .take(visible)
        .map(|item| {
            let (marker, color) = match item.tone {
                ActivityTone::Added => ("+", Color::Green),
                ActivityTone::Modified => ("~", Color::Yellow),
                ActivityTone::Deleted => ("−", Color::LightRed),
                ActivityTone::Compiler => ("◇", Color::White),
            };
            let suffix = if item.count > 1 {
                format!(" ×{}", item.count)
            } else {
                String::new()
            };
            let timestamp = compact_planning_timestamp(&item.at);
            let text = short(
                &item.text,
                usize::from(inner.width)
                    .saturating_sub(12)
                    .saturating_sub(suffix.chars().count()),
            );
            Line::from(vec![
                Span::styled(
                    format!("{timestamp:<8}  "),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    format!("{marker} {text}{suffix}"),
                    Style::default().fg(color),
                ),
            ])
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn recent_activity_title(run: Option<&RunData>, area_width: u16) -> String {
    let available_width = usize::from(area_width.saturating_sub(2));
    let identity = " Recent activity ";
    let Some(runtime) = active_runtime_label(run) else {
        return if UnicodeWidthStr::width(identity) <= available_width {
            identity.to_owned()
        } else {
            " Activity ".to_owned()
        };
    };

    let full = format!(" Recent activity · {runtime} ");
    if UnicodeWidthStr::width(full.as_str()) <= available_width {
        return full;
    }

    let elapsed = runtime.strip_suffix(" active").unwrap_or(runtime.as_str());
    let compact_elapsed = elapsed.split_whitespace().collect::<String>();
    let compact = format!(" Activity · {compact_elapsed} ");
    if UnicodeWidthStr::width(compact.as_str()) <= available_width {
        compact
    } else {
        " Activity ".to_owned()
    }
}

fn active_runtime_label(run: Option<&RunData>) -> Option<String> {
    let run = run?;
    if run.is_provisional()
        || run
            .summary
            .as_ref()
            .is_some_and(|summary| summary.status == "planning")
    {
        return None;
    }
    let approved_at = run
        .snapshot
        .get("orchestration")
        .and_then(|orchestration| orchestration.get("active_runtime_approved_at"))
        .or_else(|| {
            run.snapshot
                .get("lifecycle")
                .and_then(|lifecycle| lifecycle.get("active_runtime_approved_at"))
        })
        .and_then(Value::as_str)
        .filter(|approved_at| !approved_at.trim().is_empty())?;
    if chrono::DateTime::parse_from_rfc3339(approved_at).is_err() {
        return None;
    }
    let milliseconds = run
        .snapshot
        .get("lifecycle")
        .and_then(|lifecycle| lifecycle.get("active_runtime_milliseconds"))
        .and_then(Value::as_u64)?;
    let seconds = milliseconds / 1_000;
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3_600;
    let minutes = seconds % 3_600 / 60;
    let seconds = seconds % 60;
    let elapsed = if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    };
    Some(format!("{elapsed} active"))
}

fn recent_activity_items(run: &RunData) -> Vec<ActivityItem> {
    let mut node_labels = BTreeMap::<String, (String, String)>::new();
    for node in &run.graph {
        remember_activity_node(&mut node_labels, node);
    }
    for ticket in &run.tickets {
        for output in ticket
            .get("outputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(delta) = output_graph_delta(output) else {
                continue;
            };
            for key in ["add_nodes", "nodes", "upsert"] {
                for node in delta
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    remember_activity_node(&mut node_labels, node);
                }
            }
        }
    }

    let mut items = Vec::new();
    for ticket in &run.tickets {
        for output in ticket
            .get("outputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let at = output
                .get("recorded_at")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(delta) = output_graph_delta(output) else {
                continue;
            };
            let mut emitted = BTreeSet::new();
            for key in ["add_nodes", "nodes"] {
                for node in delta
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    push_graph_activity(
                        &mut items,
                        &mut emitted,
                        at,
                        ActivityTone::Added,
                        node,
                        &node_labels,
                    );
                }
            }
            for node in delta
                .get("upsert")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                push_graph_activity(
                    &mut items,
                    &mut emitted,
                    at,
                    ActivityTone::Modified,
                    node,
                    &node_labels,
                );
            }
            for deleted in delta
                .get("delete")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = deleted
                    .as_str()
                    .or_else(|| deleted.get("id").and_then(Value::as_str));
                let identity = id
                    .and_then(|id| node_labels.get(id))
                    .map(|(node_type, title)| (node_type.as_str(), title.as_str()));
                let text = identity.map_or_else(
                    || "Deleted graph node".to_owned(),
                    |(node_type, title)| format!("Deleted {}: {title}", humanize(node_type)),
                );
                let key = format!("deleted:{}", id.unwrap_or("unknown"));
                if emitted.insert(key) {
                    items.push(ActivityItem {
                        at: at.to_owned(),
                        text,
                        tone: ActivityTone::Deleted,
                        count: 1,
                    });
                }
            }
            for key in ["add_edges", "edges"] {
                for edge in delta
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(source) = edge.get("source").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some((node_type, title)) = node_labels.get(source) else {
                        continue;
                    };
                    let dedupe = format!("modified:{source}");
                    if emitted.insert(dedupe) {
                        items.push(ActivityItem {
                            at: at.to_owned(),
                            text: format!("Modified {}: {title}", humanize(node_type)),
                            tone: ActivityTone::Modified,
                            count: 1,
                        });
                    }
                }
            }
        }
    }

    let ticket_titles = run
        .tickets
        .iter()
        .filter_map(|ticket| {
            Some((
                ticket.get("id")?.as_str()?.to_owned(),
                display_ticket_title(ticket),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let mut compiler_buckets = BTreeSet::new();
    for event in &run.events {
        let event_type = event
            .get("event_type")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type.contains(".action.") {
            continue;
        }
        let ticket_title = event
            .get("ticket_id")
            .and_then(Value::as_str)
            .and_then(|id| ticket_titles.get(id))
            .map(String::as_str);
        let Some(text) = compiler_activity_text(event_type, ticket_title) else {
            continue;
        };
        let at = event
            .get("at")
            .or_else(|| event.get("recorded_at"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let second = at.get(..19).unwrap_or(at);
        let bucket = format!(
            "{second}\0{event_type}\0{}",
            ticket_title.unwrap_or_default()
        );
        if compiler_buckets.insert(bucket) {
            items.push(ActivityItem {
                at: at.to_owned(),
                text,
                tone: ActivityTone::Compiler,
                count: 1,
            });
        }
    }
    items.sort_by(|left, right| {
        right
            .at
            .cmp(&left.at)
            .then_with(|| left.text.cmp(&right.text))
    });
    let mut collapsed = Vec::<ActivityItem>::new();
    for item in items {
        if let Some(previous) = collapsed
            .last_mut()
            .filter(|previous| previous.tone == item.tone && previous.text == item.text)
        {
            previous.count += item.count;
        } else {
            collapsed.push(item);
        }
    }
    collapsed
}

fn output_graph_delta(output: &Value) -> Option<&Value> {
    output
        .get("typed")
        .and_then(|typed| typed.get("graph_delta"))
        .or_else(|| output.get("graph_delta"))
        .filter(|delta| delta.is_object())
}

fn remember_activity_node(labels: &mut BTreeMap<String, (String, String)>, node: &Value) {
    let Some(id) = node.get("id").and_then(Value::as_str) else {
        return;
    };
    let node_type = node
        .get("type")
        .or_else(|| node.get("node_type"))
        .and_then(Value::as_str)
        .unwrap_or("node");
    let title = node
        .get("title")
        .or_else(|| node.get("label"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Untitled graph node");
    labels.insert(id.to_owned(), (node_type.to_owned(), title.to_owned()));
}

fn push_graph_activity(
    items: &mut Vec<ActivityItem>,
    emitted: &mut BTreeSet<String>,
    at: &str,
    tone: ActivityTone,
    node: &Value,
    labels: &BTreeMap<String, (String, String)>,
) {
    let id = node.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let (node_type, title) = labels
        .get(id)
        .map(|(node_type, title)| (node_type.as_str(), title.as_str()))
        .unwrap_or(("node", "Untitled graph node"));
    let verb = match tone {
        ActivityTone::Added => "Added",
        ActivityTone::Modified => "Modified",
        ActivityTone::Deleted => "Deleted",
        ActivityTone::Compiler => return,
    };
    if emitted.insert(format!("{verb}:{id}")) {
        items.push(ActivityItem {
            at: at.to_owned(),
            text: format!("{verb} {}: {title}", humanize(node_type)),
            tone,
            count: 1,
        });
    }
}

fn compiler_activity_text(event_type: &str, ticket_title: Option<&str>) -> Option<String> {
    let with_ticket = |verb: &str| {
        ticket_title.map_or_else(|| verb.to_owned(), |title| format!("{verb}: {title}"))
    };
    Some(match event_type {
        "run.planning.started" => "Started run planning".to_owned(),
        "compiler.context.issued" => with_ticket("Prepared agent context"),
        "compiler.output.recorded" => with_ticket("Recorded step output"),
        "compiler.compile.scoped" => with_ticket("Compiled ticket"),
        "compiler.compile.full" => "Recompiled project graph".to_owned(),
        "compiler.worker.spawned" => with_ticket("Started worker"),
        "compiler.lead.spawned" => "Started Lead agent".to_owned(),
        "compiler.review.recorded" => with_ticket("Recorded review"),
        "compiler.finish.closed" => with_ticket("Closed ticket"),
        "compiler.start.leased" => with_ticket("Prepared ticket checkout"),
        "compiler.recovery.required" => with_ticket("Recovery needed"),
        "compiler.recovery.diagnostic" => "Checked recovery state".to_owned(),
        value if value.starts_with("compiler.") => humanize(value.trim_start_matches("compiler.")),
        _ => return None,
    })
}

fn live_activity_style(model: &ControlCenterModel) -> Style {
    let colors = [
        Color::Green,
        Color::LightGreen,
        Color::White,
        Color::LightGreen,
    ];
    let color = if std::env::var("TERM").as_deref() == Ok("dumb") {
        Color::Green
    } else {
        colors[model.activity_tick as usize % colors.len()]
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn draw_runs(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let block = panel_block(" Runs ", model.focus == Focus::Runs);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let controls_height = 1;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(controls_height)])
        .split(inner);
    let first = model
        .selected_run
        .saturating_sub(usize::from(rows[0].height / 2).saturating_sub(1));
    let items = if model.runs.is_empty() {
        vec![ListItem::new(Line::styled(
            "No runs yet",
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        model
            .runs
            .iter()
            .enumerate()
            .skip(first)
            .map(|(index, run)| {
                let summary = run.summary.as_ref();
                let selected = index == model.selected_run;
                let (goal, status, run_type, tickets, questions, agents, tokens, invalid) = summary
                    .map(|run| {
                        (
                            run.goal.as_str(),
                            run.status.as_str(),
                            run.run_type.as_str(),
                            run.ticket_count,
                            run.open_questions,
                            run.active_agents,
                            run.new_tokens,
                            run.validation_errors > 0,
                        )
                    })
                    .unwrap_or(("Unknown run", "unknown", "default", 0, 0, 0, 0, false));
                let live = agents > 0;
                let merge_ready = summary.is_some_and(|summary| summary.merge_ready);
                let planning_ready = summary.is_some_and(|summary| summary.status == "planning")
                    && run.planning_is_ready_for_approval();
                let marker = if invalid {
                    "!"
                } else if live {
                    "⚙"
                } else if merge_ready {
                    "◆"
                } else if planning_ready {
                    "◇"
                } else {
                    status_glyph(status)
                };
                let marker_color = if invalid {
                    Color::LightRed
                } else if live {
                    Color::Green
                } else if merge_ready {
                    Color::LightGreen
                } else if planning_ready {
                    Color::Yellow
                } else {
                    status_color(status)
                };
                let run_type = summary
                    .map(|summary| model.display_run_type_title(summary))
                    .unwrap_or_else(|| humanize(run_type));
                let target_branch = summary
                    .and_then(|summary| summary.target_branch.as_deref())
                    .and_then(|reference| reference.strip_prefix("refs/heads/"))
                    .unwrap_or("target-less");
                let lines = vec![
                    Line::from(vec![
                        Span::styled(
                            if selected { "▸ " } else { "  " },
                            Style::default().fg(Color::Cyan),
                        ),
                        Span::styled(
                            format!("{marker} "),
                            if live && !invalid {
                                live_activity_style(model)
                            } else {
                                Style::default().fg(marker_color)
                            },
                        ),
                        Span::styled(
                            goal.to_owned(),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::from(vec![
                        Span::raw("    "),
                        Span::styled(
                            format!("→ {target_branch}"),
                            Style::default().fg(if target_branch == "target-less" {
                                Color::DarkGray
                            } else {
                                Color::LightGreen
                            }),
                        ),
                        Span::styled(
                            if merge_ready {
                                " · ◆ ready to merge"
                            } else if planning_ready {
                                " · ◇ v review plan"
                            } else {
                                ""
                            },
                            Style::default()
                                .fg(Color::LightGreen)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            compact_new_token_count(tokens),
                            Style::default()
                                .fg(Color::LightMagenta)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                        Span::styled(run_type, Style::default().fg(Color::LightBlue)),
                        Span::styled(
                            format!(
                                " · {} · {tickets} tickets · {questions} ? · {agents} working",
                                humanize(status)
                            ),
                            Style::default().fg(Color::DarkGray),
                        ),
                    ]),
                ];
                ListItem::new(lines).style(if selected {
                    Style::default().bg(Color::Rgb(24, 52, 64))
                } else {
                    Style::default()
                })
            })
            .collect()
    };
    frame.render_widget(List::new(items), rows[0]);
    if controls_height > 0 {
        frame.render_widget(
            Paragraph::new(run_controls_hint(model))
                .alignment(Alignment::Center)
                .style(Style::default().fg(Color::Cyan)),
            rows[1],
        );
    }
}

fn run_controls_hint(model: &ControlCenterModel) -> String {
    if model.runs.is_empty() {
        return "n New run".to_owned();
    }
    let action = match model.selected_run_transition() {
        Some("pausing") => "Pausing…",
        Some("resuming") => "Resuming…",
        _ if !model.selected_run_running() => "Resume run",
        _ => "Pause run",
    };
    let merge = model
        .selected_run_data()
        .and_then(|run| run.summary.as_ref())
        .filter(|summary| summary.target_branch.is_some())
        .map(|summary| {
            if summary.merge_ready {
                "m Merge ready"
            } else {
                "m Review merge"
            }
        });
    let merge_suffix = if merge.is_some() { "·m merge" } else { "" };
    let review = model
        .selected_run_data()
        .is_some_and(|run| run.planning_is_ready_for_approval());
    let review_suffix = if review { "·v review" } else { "" };
    if action.starts_with("Resume") {
        format!("Space play{review_suffix}{merge_suffix}·d delete·n new")
    } else if action.starts_with("Pausing") {
        format!("Pausing…{review_suffix}{merge_suffix}·d delete·n new")
    } else if action.starts_with("Resuming") {
        format!("Resuming…{review_suffix}{merge_suffix}·d delete·n new")
    } else {
        format!("Space pause{review_suffix}{merge_suffix}·d delete·n new")
    }
}

fn draw_tickets(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let block = panel_block(" Tickets ", model.focus == Focus::Tickets);
    frame.render_widget(block, area);
    let (switcher, items_area) = bordered_switcher_and_body(area);
    let tab_count = model
        .selected_run_data()
        .map(|run| {
            run.tickets
                .iter()
                .filter(|ticket| model.ticket_tab.includes(ticket))
                .count()
        })
        .unwrap_or_default();
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("‹ ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{} {tab_count}", humanize(model.ticket_tab.label())),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" ›", Style::default().fg(Color::DarkGray)),
        ]))
        .alignment(Alignment::Center),
        switcher,
    );
    let tickets = model.visible_tickets();
    let first = model
        .selected_ticket
        .saturating_sub(usize::from(items_area.height / 2).saturating_sub(1));
    let items = if tickets.is_empty() {
        vec![ListItem::new(Line::styled(
            format!("no {} tickets", model.ticket_tab.label()),
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        tickets
            .iter()
            .enumerate()
            .skip(first)
            .map(|(index, ticket)| {
                ticket_item(
                    ticket,
                    index == model.selected_ticket,
                    model.selected_run_data(),
                    model,
                )
            })
            .collect()
    };
    frame.render_widget(List::new(items), items_area);
}

fn ticket_item(
    ticket: &Value,
    selected: bool,
    run: Option<&RunData>,
    model: &ControlCenterModel,
) -> ListItem<'static> {
    let title = display_ticket_title(ticket);
    let status = ticket
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let progress = ticket_progress(ticket, run);
    let blocked = ticket
        .get("blockers")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let marker = if blocked || progress.worker_failed {
        "!"
    } else {
        status_glyph(status)
    };
    let marker_color = if blocked || progress.worker_failed {
        Color::LightRed
    } else {
        status_color(status)
    };
    let first_line = Line::from(vec![
        Span::styled(
            if selected { "▸ " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(format!("{marker} "), Style::default().fg(marker_color)),
        Span::styled(title, Style::default().add_modifier(Modifier::BOLD)),
    ]);
    let mut second_spans = vec![Span::raw("    ")];
    second_spans.extend(workflow_rail_spans(&progress.states, &progress.glyphs));
    if !progress.states.is_empty() {
        second_spans.push(Span::styled(
            format!("  {}/{}", progress.done, progress.states.len()),
            Style::default().fg(Color::DarkGray),
        ));
    }
    if let Some(persona) = progress.current_persona {
        second_spans.push(Span::styled(
            format!(" · {}", humanize(&persona)),
            Style::default().fg(Color::LightBlue),
        ));
    }
    if progress.worker_running {
        second_spans.push(Span::styled(" ⚙", live_activity_style(model)));
    } else if progress.worker_failed {
        second_spans.push(Span::styled(
            " · recovery needed",
            Style::default().fg(Color::LightRed),
        ));
    }
    let background = if selected {
        Style::default().bg(Color::Rgb(24, 52, 64))
    } else {
        Style::default()
    };
    ListItem::new(vec![first_line, Line::from(second_spans)]).style(background)
}

fn draw_graph(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let diff = selected_ticket_graph_diff(model);
    let nodes = diff.as_ref().map_or_else(
        || model.selected_graph_values().to_vec(),
        |diff| diff.graph.clone(),
    );
    let scope = if diff.is_some() {
        "ticket checkout"
    } else {
        "integration"
    };
    let title = if area.width < 40 {
        if diff.is_some() {
            format!(" Checkout graph · {} nodes ", nodes.len())
        } else {
            format!(" Project graph · {} nodes ", nodes.len())
        }
    } else if diff.is_some() && area.width < 48 {
        format!(" Graph · {scope} · {} nodes ", nodes.len())
    } else {
        format!(" Project graph · {scope} · {} nodes ", nodes.len())
    };
    let mut block = panel_block(&title, model.focus == Focus::Graph);
    if let Some(diff) = &diff {
        block = block.title_bottom(graph_diff_legend(diff, area.width));
    }
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let renderer = graph_renderer_for_options(
        std::env::var("TERM").as_deref() == Ok("dumb"),
        model.selected_graph_options(),
    );
    let width = usize::from(inner.width);
    let rendered = renderer.render_values(&nodes, width);
    let visible_height = usize::from(inner.height);
    let scroll = model
        .graph_scroll
        .min(rendered.len().saturating_sub(visible_height));
    let lines = rendered
        .iter()
        .skip(scroll)
        .take(visible_height)
        .map(|line| graph_line(line, diff.as_ref()))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), inner);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum GraphChange {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone)]
struct TicketGraphDiff {
    graph: Vec<Value>,
    nodes: BTreeMap<String, GraphChange>,
    edges: BTreeMap<GraphEdgeRef, GraphChange>,
}

fn selected_ticket_graph_diff(model: &ControlCenterModel) -> Option<TicketGraphDiff> {
    if !model.selected_graph_is_ticket_projection() {
        return None;
    }
    let run = model.selected_run_data()?;
    let ticket_id = model.selected_ticket_value()?.get("id")?.as_str()?;
    let projected = run.ticket_graphs.get(ticket_id)?;
    Some(ticket_graph_diff(&run.graph, projected))
}

fn ticket_graph_diff(baseline: &[Value], projected: &[Value]) -> TicketGraphDiff {
    let baseline_nodes = graph_nodes_by_id(baseline);
    let projected_nodes = graph_nodes_by_id(projected);
    let mut nodes = BTreeMap::new();
    for id in baseline_nodes.keys().chain(projected_nodes.keys()) {
        let change = match (baseline_nodes.get(id), projected_nodes.get(id)) {
            (None, Some(_)) => Some(GraphChange::Added),
            (Some(_), None) => Some(GraphChange::Deleted),
            (Some(before), Some(after))
                if graph_node_metadata(before) != graph_node_metadata(after) =>
            {
                Some(GraphChange::Modified)
            }
            _ => None,
        };
        if let Some(change) = change {
            nodes.insert(id.clone(), change);
        }
    }

    let baseline_edges = graph_edge_set(baseline);
    let projected_edges = graph_edge_set(projected);
    let mut edges = BTreeMap::new();
    for edge in projected_edges.difference(&baseline_edges) {
        edges.insert(edge.clone(), GraphChange::Added);
    }
    for edge in baseline_edges.difference(&projected_edges) {
        edges.insert(edge.clone(), GraphChange::Deleted);
    }
    // A relation rename between the same semantic endpoints reads as one
    // modification, not as an unrelated red/green pair.
    let changed_pairs = edges
        .keys()
        .map(|edge| (edge.source.clone(), edge.target.clone()))
        .collect::<BTreeSet<_>>();
    for (source, target) in changed_pairs {
        let has_addition = edges.iter().any(|(edge, change)| {
            edge.source == source && edge.target == target && *change == GraphChange::Added
        });
        let has_deletion = edges.iter().any(|(edge, change)| {
            edge.source == source && edge.target == target && *change == GraphChange::Deleted
        });
        if has_addition && has_deletion {
            for (edge, change) in &mut edges {
                if edge.source == source && edge.target == target {
                    *change = GraphChange::Modified;
                }
            }
        }
    }

    let mut union = baseline_nodes;
    union.extend(projected_nodes);
    let union_edges = baseline_edges
        .union(&projected_edges)
        .cloned()
        .collect::<Vec<_>>();
    for node in union.values_mut() {
        if let Some(object) = node.as_object_mut() {
            object.insert("edges".to_owned(), Value::Object(Default::default()));
        }
    }
    for edge in union_edges {
        let Some(source) = union.get_mut(&edge.source).and_then(Value::as_object_mut) else {
            continue;
        };
        let relations = source
            .entry("edges".to_owned())
            .or_insert_with(|| Value::Object(Default::default()));
        let Some(relations) = relations.as_object_mut() else {
            continue;
        };
        let targets = relations
            .entry(edge.relation)
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(targets) = targets.as_array_mut() {
            targets.push(Value::String(edge.target));
        }
    }
    let graph = union.into_values().collect();
    TicketGraphDiff {
        graph,
        nodes,
        edges,
    }
}

fn graph_nodes_by_id(values: &[Value]) -> BTreeMap<String, Value> {
    values
        .iter()
        .filter_map(|node| {
            node.get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), node.clone()))
        })
        .collect()
}

fn graph_node_metadata(node: &Value) -> Value {
    let mut node = node.clone();
    if let Some(object) = node.as_object_mut() {
        object.remove("edges");
    }
    node
}

fn graph_edge_set(values: &[Value]) -> BTreeSet<GraphEdgeRef> {
    let mut output = BTreeSet::new();
    for node in values {
        let Some(source) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(relations) = node.get("edges").and_then(Value::as_object) else {
            continue;
        };
        for (relation, targets) in relations {
            match targets {
                Value::Array(targets) => {
                    for target in targets.iter().filter_map(Value::as_str) {
                        output.insert(GraphEdgeRef {
                            source: source.to_owned(),
                            relation: relation.clone(),
                            target: target.to_owned(),
                        });
                    }
                }
                Value::String(target) => {
                    output.insert(GraphEdgeRef {
                        source: source.to_owned(),
                        relation: relation.clone(),
                        target: target.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    output
}

fn graph_diff_legend(diff: &TicketGraphDiff, width: u16) -> Line<'static> {
    let count = |change| {
        diff.nodes
            .values()
            .filter(|value| **value == change)
            .count()
            + diff
                .edges
                .values()
                .filter(|value| **value == change)
                .count()
    };
    if width < 40 {
        return Line::from(vec![
            Span::styled(
                format!(" +{} ", count(GraphChange::Added)),
                graph_change_style(GraphChange::Added, true),
            ),
            Span::styled(
                format!(" ~{} ", count(GraphChange::Modified)),
                graph_change_style(GraphChange::Modified, true),
            ),
            Span::styled(
                format!(" −{} ", count(GraphChange::Deleted)),
                graph_change_style(GraphChange::Deleted, true),
            ),
        ]);
    }
    Line::from(vec![
        Span::styled(
            format!(" + {} added ", count(GraphChange::Added)),
            graph_change_style(GraphChange::Added, true),
        ),
        Span::styled(
            format!(" ~ {} modified ", count(GraphChange::Modified)),
            graph_change_style(GraphChange::Modified, true),
        ),
        Span::styled(
            format!(" − {} deleted ", count(GraphChange::Deleted)),
            graph_change_style(GraphChange::Deleted, true),
        ),
    ])
}

pub(crate) fn graph_renderer_for_options(ascii: bool, options: Option<&Value>) -> GraphRenderer {
    let mut renderer = GraphRenderer::new(ascii);
    if let Some(options) = options {
        if let Some(layout) = options.get("layout").and_then(Value::as_str) {
            renderer = renderer.with_layout(layout);
        }
        renderer = renderer.with_upward_edge_policy(
            options
                .get("upward_edge_policy")
                .and_then(Value::as_str)
                .unwrap_or("preserve"),
        );
        let hierarchy = options
            .get("hierarchy")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        renderer = renderer.with_hierarchy(hierarchy);
        let layers = options
            .get("layers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|layer| match layer {
                Value::Array(types) => types
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>(),
                Value::String(node_type) => vec![node_type.clone()],
                _ => Vec::new(),
            })
            .filter(|layer| !layer.is_empty())
            .collect::<Vec<_>>();
        renderer = renderer.with_layers(layers);
        let repeat_semantic_types = options
            .get("repeat_semantic_types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        renderer = renderer.with_repeat_semantic_types(repeat_semantic_types);
        let preferences = options
            .get("primary_parent_preferences")
            .and_then(Value::as_object)
            .map(|preferences| {
                preferences
                    .iter()
                    .map(|(child, parents)| {
                        (
                            child.clone(),
                            parents
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .map(ToOwned::to_owned)
                                .collect(),
                        )
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        if !preferences.is_empty() {
            renderer = renderer.with_parent_preferences(preferences);
        }
        let labels = match options.get("reverse_display_edges") {
            Some(Value::Object(edges)) => edges
                .iter()
                .filter_map(|(edge, label)| {
                    let (node_type, relation) = edge.split_once('.')?;
                    Some((
                        (node_type.to_owned(), relation.to_owned()),
                        label.as_str().unwrap_or(relation).to_owned(),
                    ))
                })
                .collect(),
            Some(Value::Array(edges)) => edges
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|edge| edge.split_once('.'))
                .map(|(node_type, relation)| {
                    (
                        (node_type.to_owned(), relation.to_owned()),
                        relation.to_owned(),
                    )
                })
                .collect(),
            _ => BTreeMap::new(),
        };
        renderer = renderer.with_reverse_labels(labels);
        renderer = renderer.with_titles(
            options
                .get("show_titles")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        );
    }
    renderer
}

fn graph_change_style(change: GraphChange, emphatic: bool) -> Style {
    let color = match change {
        GraphChange::Added => Color::LightGreen,
        GraphChange::Modified => Color::Yellow,
        GraphChange::Deleted => Color::LightRed,
    };
    let style = Style::default().fg(color);
    if emphatic {
        style.add_modifier(Modifier::BOLD)
    } else {
        style
    }
}

fn edge_span_change(edge_refs: &[GraphEdgeRef], diff: &TicketGraphDiff) -> Option<GraphChange> {
    let mut changes = edge_refs
        .iter()
        .filter_map(|edge_ref| diff.edges.get(edge_ref).copied())
        .collect::<BTreeSet<_>>();
    if changes.len() > 1 {
        Some(GraphChange::Modified)
    } else {
        changes.pop_first()
    }
}

fn graph_line(line: &crate::graph::GraphLine, diff: Option<&TicketGraphDiff>) -> Line<'static> {
    let characters: Vec<_> = line.text.chars().collect();
    if characters.is_empty() {
        return Line::raw("");
    }
    let connector_style = if diff.is_some() {
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::DIM)
    } else {
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD)
    };
    let title_style = Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::DIM);
    let mut styles = vec![connector_style; characters.len()];
    for span in &line.edge_spans {
        let style = diff.map_or_else(
            || {
                Style::default()
                    .fg(node_color(&span.node_type))
                    .add_modifier(Modifier::BOLD)
            },
            |diff| {
                edge_span_change(&span.edge_refs, diff)
                    .map(|change| graph_change_style(change, true))
                    .unwrap_or(connector_style)
            },
        );
        for target in styles
            .iter_mut()
            .take(span.end.min(characters.len()))
            .skip(span.start.min(characters.len()))
        {
            *target = style;
        }
    }
    for span in &line.title_spans {
        let style = diff
            .and_then(|diff| span.node_id.as_ref().and_then(|id| diff.nodes.get(id)))
            .copied()
            .map(|change| graph_change_style(change, false))
            .unwrap_or(title_style);
        for target in styles
            .iter_mut()
            .take(span.end.min(characters.len()))
            .skip(span.start.min(characters.len()))
        {
            *target = style;
        }
    }
    for span in &line.node_spans {
        let style = diff.map_or_else(
            || {
                Style::default()
                    .fg(node_color(&span.node_type))
                    .add_modifier(Modifier::BOLD)
            },
            |diff| {
                span.node_id
                    .as_ref()
                    .and_then(|id| diff.nodes.get(id))
                    .copied()
                    .map(|change| graph_change_style(change, true))
                    .unwrap_or(connector_style)
            },
        );
        for target in styles
            .iter_mut()
            .take(span.end.min(characters.len()))
            .skip(span.start.min(characters.len()))
        {
            *target = style;
        }
    }
    let mut spans = Vec::new();
    let mut start = 0usize;
    for index in 1..=characters.len() {
        if index == characters.len() || styles[index] != styles[start] {
            spans.push(Span::styled(
                characters[start..index].iter().collect::<String>(),
                styles[start],
            ));
            start = index;
        }
    }
    Line::from(spans)
}

fn draw_details(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    if model.agent_chat_is_open() {
        draw_agent_chat(frame, model, area);
        return;
    }
    let block = details_block(model, area.width);
    let body = block.inner(area);
    frame.render_widget(block, area);
    let lines = detail_lines(model, usize::from(body.width).max(1));
    frame.render_widget(
        Paragraph::new(lines)
            .scroll((model.detail_scroll.min(u16::MAX as usize) as u16, 0))
            .wrap(Wrap { trim: false }),
        body,
    );
}

const DETAILS_TITLE_PREFIX: &str = " Details: ";
const DETAILS_TITLE_SEPARATOR: &str = " - ";
const COMPACT_DETAILS_TITLE_PREFIX: &str = " D:";
const COMPACT_DETAILS_TITLE_SEPARATOR: &str = "-";

fn details_title_tokens(available_width: u16) -> (&'static str, &'static str) {
    let full_width = UnicodeWidthStr::width(DETAILS_TITLE_PREFIX)
        + Panel::ALL
            .iter()
            .map(|panel| UnicodeWidthStr::width(humanize(panel.label()).as_str()))
            .sum::<usize>()
        + UnicodeWidthStr::width(DETAILS_TITLE_SEPARATOR) * (Panel::ALL.len() - 1);
    if usize::from(available_width) >= full_width {
        (DETAILS_TITLE_PREFIX, DETAILS_TITLE_SEPARATOR)
    } else {
        (
            COMPACT_DETAILS_TITLE_PREFIX,
            COMPACT_DETAILS_TITLE_SEPARATOR,
        )
    }
}

fn details_block(model: &ControlCenterModel, area_width: u16) -> Block<'static> {
    let (prefix, separator) = details_title_tokens(area_width.saturating_sub(2));
    let mut spans = vec![Span::styled(
        prefix,
        Style::default().fg(if model.focus == Focus::Details {
            Color::Cyan
        } else {
            Color::Gray
        }),
    )];
    for (index, panel) in Panel::ALL.into_iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(
                separator,
                Style::default().fg(Color::DarkGray),
            ));
        }
        spans.push(Span::styled(
            humanize(panel.label()),
            if panel == model.detail_panel {
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            },
        ));
    }
    spans.push(Span::raw(" "));
    Block::default()
        .borders(Borders::ALL)
        .title(Line::from(spans))
        .border_style(if model.focus == Focus::Details {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        })
}

fn detail_tab_areas(area: Rect) -> Rc<[Rect]> {
    let (prefix, separator) = details_title_tokens(area.width);
    let mut x = area.x.saturating_add(UnicodeWidthStr::width(prefix) as u16);
    let mut tabs = Vec::with_capacity(Panel::ALL.len());
    for (index, panel) in Panel::ALL.into_iter().enumerate() {
        if index > 0 {
            x = x.saturating_add(UnicodeWidthStr::width(separator) as u16);
        }
        let width = UnicodeWidthStr::width(humanize(panel.label()).as_str()) as u16;
        let clipped = width.min(area.right().saturating_sub(x));
        tabs.push(Rect::new(x, area.y, clipped, area.height.min(1)));
        x = x.saturating_add(width);
    }
    tabs.into()
}

pub(crate) fn detail_panel_at(column: u16, row: u16, area: Rect) -> Option<Panel> {
    if row < area.y || row >= area.bottom() {
        return None;
    }
    Panel::ALL
        .into_iter()
        .zip(detail_tab_areas(area).iter().copied())
        .find_map(|(panel, tab)| rect_contains(tab, column, row).then_some(panel))
}

fn draw_agent_chat(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let agents = model.selected_agent_summaries();
    let agent = agents.get(model.selected_agent);
    let rendered = model.selected_agent_chat_render(area.width.saturating_sub(2));
    let active = rendered
        .as_ref()
        .is_some_and(|rendered| rendered.has_running_operation);
    let title = agent.map_or_else(
        || " Chat ".to_owned(),
        |agent| {
            let prefix = if active { "⚙ " } else { "" };
            if model.agent_chat_scroll_from_top.is_none()
                && model.agent_chat_scroll_from_bottom == 0
            {
                format!(" {prefix}Chat · {} ", agent.persona)
            } else {
                format!(" {prefix}Chat · {} · history ", agent.persona)
            }
        },
    );
    let block = panel_block(&title, model.focus == Focus::Details);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if agent.is_none() {
        frame.render_widget(
            Paragraph::new("Select an agent to inspect its conversation."),
            inner,
        );
        return;
    }
    let Some(rendered) = rendered else {
        return;
    };
    let viewport = usize::from(inner.height);
    let maximum_offset = rendered.lines.len().saturating_sub(viewport);
    let offset = model.agent_chat_scroll_from_top.map_or_else(
        || {
            let from_bottom = model.agent_chat_scroll_from_bottom.min(maximum_offset);
            maximum_offset.saturating_sub(from_bottom)
        },
        |from_top| from_top.min(maximum_offset),
    );
    frame.render_widget(
        Paragraph::new(rendered.lines.as_ref().clone())
            .scroll((offset.min(u16::MAX as usize) as u16, 0)),
        inner,
    );
}

fn detail_lines(model: &ControlCenterModel, width: usize) -> Text<'static> {
    let run = model.selected_run_data();
    match model.detail_panel {
        Panel::Overview => {
            let overview_subject = match model.focus {
                Focus::Runs => OverviewSubject::Run,
                Focus::Tickets => OverviewSubject::Ticket,
                _ => model.overview_subject,
            };
            if overview_subject == OverviewSubject::Run {
                return run_overview_details(model, run, width);
            }
            let Some(ticket) = model.selected_ticket_value() else {
                return run_overview_details(model, run, width);
            };
            let mut overview = metadata_text(ticket, run, model, width);
            if let Some(run) = run {
                overview.lines.extend([
                    Line::raw(""),
                    Line::styled("Run health & evidence", heading_style()),
                ]);
                overview.lines.extend(
                    report_text(run, model.selected_graph_values().len(), model, true).lines,
                );
            }
            overview
        }
        Panel::Planning => {
            if let Some(run) = run.filter(|run| run_plan_is_approved(run)) {
                return approved_plan_text(run, width);
            }
            let transcript = run
                .map(|run| run.planning_transcript.as_slice())
                .unwrap_or_default();
            if transcript.is_empty() {
                Text::from("No planning transcript for this run.")
            } else {
                planning_timeline(
                    transcript,
                    run.map(|run| run.stages.as_slice()).unwrap_or_default(),
                    width,
                )
            }
        }
        Panel::Stages => {
            let stages = run.map(|run| run.stages.as_slice()).unwrap_or_default();
            let loops = run
                .map(|run| run.external_loops.as_slice())
                .unwrap_or_default();
            let repairs = run
                .map(|run| run.external_repairs.as_slice())
                .unwrap_or_default();
            if stages.is_empty() && loops.is_empty() && repairs.is_empty() {
                return Text::from("No pipeline stages recorded.");
            }
            let mut text = Text::default();
            if let Some(stage) = stages.iter().find(|stage| {
                !matches!(
                    stage.get("status").and_then(Value::as_str),
                    Some("succeeded" | "skipped")
                )
            }) {
                let definition = stage.get("definition").unwrap_or(stage);
                text.lines.extend([
                    Line::styled(
                        format!("▶ Current {} stage", pipeline_stage_category(definition)),
                        Style::default()
                            .fg(Color::Black)
                            .bg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Line::raw(""),
                ]);
            }
            text.lines
                .extend(pipeline_stage_cards(stages, run, model, width).lines);
            if !loops.is_empty() {
                text.lines
                    .push(Line::styled("external loops", heading_style()));
                text.lines.extend(
                    json_cards(
                        loops,
                        &["title", "summary", "provider", "kind"],
                        "External review loop",
                    )
                    .lines,
                );
            }
            if !repairs.is_empty() {
                text.lines
                    .push(Line::styled("repair requests", heading_style()));
                text.lines.extend(
                    json_cards(
                        repairs,
                        &["title", "summary", "reason", "kind"],
                        "Repair request",
                    )
                    .lines,
                );
            }
            text
        }
    }
}

fn run_plan_is_approved(run: &RunData) -> bool {
    run.stages.iter().any(|stage| {
        if stage.get("status").and_then(Value::as_str) != Some("succeeded") {
            return false;
        }
        let definition = stage.get("definition").unwrap_or(stage);
        if pipeline_stage_category(definition) == "Approval" {
            return true;
        }
        let id = definition
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = definition
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        id == "explicit_run_approval" || title_has_word(title, &["approve", "approval"])
    })
}

fn approved_plan_text(run: &RunData, width: usize) -> Text<'static> {
    let Some(summary) = run.summary.as_ref() else {
        return Text::from("No approved plan is available for this run.");
    };
    let sections = durable_approved_plan_sections(run, summary);
    if sections.is_empty() {
        return Text::from("No durable approved plan is available for this run.");
    }
    let mut lines = vec![Line::styled(
        "Approved plan",
        Style::default()
            .fg(Color::LightGreen)
            .add_modifier(Modifier::BOLD),
    )];
    for section in sections {
        lines.extend([Line::raw(""), overview_section_heading(&section.title)]);
        lines.extend(approval_markdown_lines(
            &section.body,
            width.saturating_sub(2).max(1),
        ));
    }
    Text::from(lines)
}

fn run_overview_details(
    model: &ControlCenterModel,
    run: Option<&RunData>,
    width: usize,
) -> Text<'static> {
    let mut lines = Vec::new();
    if let Some(errors) = run
        .and_then(|run| run.snapshot.get("validation_errors"))
        .and_then(Value::as_array)
        .filter(|errors| !errors.is_empty())
    {
        lines.push(Line::styled(
            format!(
                "! {} validation issue{}",
                errors.len(),
                plural(errors.len())
            ),
            Style::default()
                .fg(Color::LightRed)
                .add_modifier(Modifier::BOLD),
        ));
        lines.extend(errors.iter().map(|error| {
            let message = error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
                .unwrap_or("Configuration or project state is invalid");
            Line::raw(format!("  • {message}"))
        }));
        lines.push(Line::raw(""));
    }

    let objective = run
        .and_then(|run| run.summary.as_ref())
        .map(|summary| summary.goal.trim())
        .filter(|objective| !objective.is_empty());

    lines.push(overview_section_heading("Objective"));
    if let Some(objective) = objective {
        let collapsed_lines = (model.focus != Focus::Details).then_some(4);
        lines.extend(objective_preview_lines(objective, width, collapsed_lines));
    } else {
        lines.push(Line::styled(
            "No objective recorded.",
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.push(Line::raw(""));

    lines.push(overview_section_heading("Run"));
    let metadata = run
        .and_then(|run| run.summary.as_ref().map(|summary| (run, summary)))
        .map(|(run, summary)| {
            run_overview_text(run, summary, &model.display_run_type_title(summary), model)
        })
        .unwrap_or_else(|| Text::from("No run overview available."));
    lines.extend(metadata.lines);
    lines.push(Line::raw(""));

    lines.push(overview_section_heading("Evidence"));
    if let Some(run) = run {
        lines.extend(report_text(run, run.graph.len(), model, false).lines);
    } else {
        lines.push(Line::styled(
            "No run evidence available.",
            Style::default().fg(Color::DarkGray),
        ));
    }
    Text::from(lines)
}

fn overview_section_heading(label: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled("▸ ", Style::default().fg(Color::Cyan)),
        Span::styled(
            label.to_owned(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn objective_preview_lines(
    objective: &str,
    width: usize,
    maximum_lines: Option<usize>,
) -> Vec<Line<'static>> {
    let wrapped = objective
        .split('\n')
        .flat_map(|source| {
            if source.is_empty() {
                vec![String::new()]
            } else {
                wrap_full_text(source.trim_end_matches('\r'), width.max(1))
            }
        })
        .collect::<Vec<_>>();
    let limit = maximum_lines.unwrap_or(usize::MAX);
    let truncated = wrapped.len() > limit;
    let mut visible = wrapped.into_iter().take(limit).collect::<Vec<_>>();
    if truncated && let Some(last) = visible.last_mut() {
        let budget = width.saturating_sub(1).max(1);
        *last = format!("{}…", truncate_graph_line(last, budget));
    }
    visible.into_iter().map(Line::raw).collect()
}

fn metadata_text(
    ticket: &Value,
    run: Option<&RunData>,
    model: &ControlCenterModel,
    width: usize,
) -> Text<'static> {
    let status = ticket
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let operation = string_at(ticket, "operation");
    let progress = ticket_progress(ticket, run);
    let mut lines = vec![Line::styled(
        display_ticket_title(ticket),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )];
    lines.push(Line::from(vec![
        Span::styled(
            format!(" {} {} ", status_glyph(status), humanize(status)),
            Style::default()
                .fg(Color::Black)
                .bg(status_color(status))
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(humanize(&operation), Style::default().fg(Color::LightBlue)),
    ]));
    if progress.worker_running {
        lines.push(Line::styled(
            format!(
                "⚙ Working now{}",
                progress
                    .current_persona
                    .as_deref()
                    .map(|persona| format!(" · {}", humanize(persona)))
                    .unwrap_or_default()
            ),
            live_activity_style(model),
        ));
    } else if progress.worker_failed {
        lines.push(Line::styled(
            format!(
                "! Worker exited before recording output{}",
                progress
                    .current_persona
                    .as_deref()
                    .map(|persona| format!(" · {}", humanize(persona)))
                    .unwrap_or_default()
            ),
            Style::default()
                .fg(Color::LightRed)
                .add_modifier(Modifier::BOLD),
        ));
    } else if ticket.get("lease").is_some_and(|lease| !lease.is_null()) && !ticket_is_closed(ticket)
    {
        lines.push(Line::styled(
            "◇ Ticket checkout is ready",
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.extend([
        Line::raw(""),
        Line::from(vec![
            Span::styled("Workflow  ", heading_style()),
            Span::styled(
                format!("{}/{} complete", progress.done, progress.states.len()),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(workflow_rail_spans(&progress.states, &progress.glyphs)),
    ]);
    let scope_lines = ticket.get("scope").map(|scope| {
        let read_nodes = value_len(scope.get("read_nodes"));
        let write_nodes = value_len(scope.get("write_nodes"));
        let read_paths = value_len(scope.get("read_paths"));
        let write_paths = value_len(scope.get("write_paths"));
        vec![
            Line::raw(""),
            Line::styled("Scope", heading_style()),
            Line::styled(
                format!(
                    "◇ {read_nodes} node{} readable · {write_nodes} writable",
                    plural(read_nodes)
                ),
                Style::default().fg(Color::LightBlue),
            ),
            Line::styled(
                format!(
                    "◇ {read_paths} path{} readable · {write_paths} writable",
                    plural(read_paths)
                ),
                Style::default().fg(Color::DarkGray),
            ),
        ]
    });
    lines.extend([Line::raw(""), Line::styled("Steps", heading_style())]);
    let outputs = ticket
        .get("outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let workflow = ticket
        .get("workflow")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, step) in workflow.iter().enumerate() {
        let state = progress
            .states
            .get(index)
            .copied()
            .unwrap_or(StepVisualState::Pending);
        let id = string_at(step, "id");
        let connector = if index + 1 == workflow.len() {
            "└"
        } else {
            "├"
        };
        let persona = string_at(step, "persona");
        let step_name = humanize(&id);
        let persona_name = humanize(&persona);
        let state_name = step_label(state);
        let state_width = if state == StepVisualState::Done {
            0
        } else {
            2 + state_name.chars().count()
        };
        let wide_width =
            4 + step_name.chars().count() + state_width + 5 + persona_name.chars().count();
        if width >= 52 && wide_width <= width {
            let mut spans = vec![
                Span::styled(
                    format!("{connector}─"),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    format!("{} ", progress.glyphs.for_state(state)),
                    Style::default().fg(step_color(state)),
                ),
                Span::styled(step_name, Style::default().add_modifier(Modifier::BOLD)),
            ];
            if state != StepVisualState::Done {
                spans.push(Span::styled(
                    format!("  {state_name}"),
                    Style::default().fg(step_color(state)),
                ));
            }
            spans.extend([
                Span::styled("  ·  ", Style::default().fg(Color::DarkGray)),
                Span::styled(persona_name, Style::default().fg(Color::LightBlue)),
            ]);
            lines.push(Line::from(spans));
        } else {
            let persona_name = compact_step_persona(&persona);
            let suffix_width = if state == StepVisualState::Done {
                3 + persona_name.chars().count()
            } else {
                3 + state_name.chars().count() + 3 + persona_name.chars().count()
            };
            let name_budget = width.saturating_sub(4 + suffix_width).max(1);
            let mut spans = vec![
                Span::styled(
                    format!("{connector}─"),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    format!("{} ", progress.glyphs.for_state(state)),
                    Style::default().fg(step_color(state)),
                ),
                Span::styled(
                    truncate_graph_line(&step_name, name_budget),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
            ];
            if state != StepVisualState::Done {
                spans.extend([
                    Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                    Span::styled(state_name, Style::default().fg(step_color(state))),
                ]);
            }
            spans.extend([
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(persona_name, Style::default().fg(Color::LightBlue)),
            ]);
            lines.push(Line::from(spans));
        }
        let prefix = if index + 1 == workflow.len() {
            "   "
        } else {
            "│  "
        };
        let output = outputs
            .iter()
            .find(|output| string_at(output, "step_id") == id);
        if state == StepVisualState::Done {
            let (summary, style) = completed_step_summary(ticket, step, output).map_or_else(
                || {
                    (
                        "No outcome summary recorded".to_owned(),
                        Style::default().fg(Color::DarkGray),
                    )
                },
                |summary| (summary, Style::default().fg(Color::Green)),
            );
            lines.extend(prefixed_detail_lines(prefix, &summary, width, style));
        } else if let Some(expected) =
            step.get("expected_output")
                .and_then(Value::as_str)
                .or_else(|| {
                    step.get("expected_outputs")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(Value::as_str)
                })
        {
            lines.extend(prefixed_detail_lines(
                prefix,
                &format!("expects {}", short(expected, 62)),
                width,
                Style::default().fg(Color::DarkGray),
            ));
        }
    }
    if let Some(scope_lines) = scope_lines {
        lines.extend(scope_lines);
    }
    lines.extend(ticket_blocker_lines(ticket, run, width));
    Text::from(lines)
}

/// Project the first useful durable blocker into operator-facing prose.
///
/// Blocker records are compiler evidence, but their raw messages may contain
/// record identifiers, hashes, or checkout paths. Keep those exact bytes on
/// disk and redact only this display projection. If no message remains useful
/// after redaction, retain the older count-only disclosure instead of
/// inventing a reason.
fn ticket_blocker_lines(ticket: &Value, run: Option<&RunData>, width: usize) -> Vec<Line<'static>> {
    let Some(blockers) = ticket.get("blockers").and_then(Value::as_array) else {
        return Vec::new();
    };
    if blockers.is_empty() {
        return Vec::new();
    }

    let style = Style::default().fg(Color::LightRed);
    let durable_blockers = blockers
        .iter()
        .filter(|blocker| ticket_blocker_is_durable(blocker))
        .collect::<Vec<_>>();
    let Some(reason) = durable_blockers
        .iter()
        .find_map(|blocker| ticket_blocker_reason(blocker, run))
    else {
        return vec![
            Line::raw(""),
            Line::styled(
                format!(
                    "! {} blocker{} need attention",
                    blockers.len(),
                    plural(blockers.len())
                ),
                style,
            ),
        ];
    };

    let content_width = width.saturating_sub(2).max(1);
    let mut lines = vec![Line::raw("")];
    for (index, line) in wrap_blocker_reason(&reason, content_width)
        .into_iter()
        .enumerate()
    {
        lines.push(Line::styled(
            format!("{}{line}", if index == 0 { "! " } else { "  " }),
            style,
        ));
    }
    if durable_blockers.len() > 1 {
        lines.push(Line::styled(
            format!("  +{} more", durable_blockers.len() - 1),
            Style::default().fg(Color::Red),
        ));
    }
    lines
}

fn ticket_blocker_is_durable(blocker: &Value) -> bool {
    blocker.get("kind").and_then(Value::as_str).is_some()
        && blocker.get("message").and_then(Value::as_str).is_some()
        && blocker.get("created_at").and_then(Value::as_str).is_some()
}

fn ticket_blocker_reason(blocker: &Value, run: Option<&RunData>) -> Option<String> {
    let message = blocker.get("message")?.as_str()?;
    let kind = blocker
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = collapse_display_whitespace(message);
    if blocker_reason_is_generic(&message, kind)
        || serde_json::from_str::<Value>(&message)
            .is_ok_and(|value| value.is_object() || value.is_array())
    {
        return None;
    }

    let known_records_redacted = run.map_or_else(
        || message.clone(),
        |run| redact_blocker_control_record_ids(&message, run),
    );
    let without_raw_record = redact_embedded_compiler_record(&known_records_redacted);
    let sanitized = without_raw_record
        .split_whitespace()
        .map(sanitize_blocker_token)
        .collect::<Vec<_>>()
        .join(" ");
    let sanitized = collapse_display_whitespace(&sanitized);
    if blocker_reason_is_generic(&sanitized, kind)
        || !blocker_reason_has_semantic_content(&sanitized)
        || matches!(
            sanitized.to_ascii_lowercase().as_str(),
            "a local path"
                | "a content hash"
                | "an internal record"
                | "an internal compiler record"
        )
    {
        None
    } else {
        Some(sanitized)
    }
}

fn redact_blocker_control_record_ids(message: &str, run: &RunData) -> String {
    let mut replacements = BTreeMap::<String, String>::new();
    let mut add = |value: Option<&str>, replacement: &str| {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            replacements
                .entry(value.to_owned())
                .or_insert_with(|| replacement.to_owned());
        }
    };
    add(
        run.summary.as_ref().map(|summary| summary.id.as_str()),
        "this run",
    );
    for ticket in &run.tickets {
        add(
            ticket.get("id").and_then(Value::as_str),
            "the affected ticket",
        );
    }
    for stage in &run.stages {
        let definition = stage.get("definition").unwrap_or(stage);
        add(
            definition.get("id").and_then(Value::as_str),
            "the affected stage",
        );
    }
    for agent in &run.agents {
        add(
            agent.get("id").and_then(Value::as_str),
            "the affected agent",
        );
    }
    for node in &run.graph {
        add(
            node.get("id").and_then(Value::as_str),
            "the affected graph item",
        );
    }
    for question in &run.questions {
        add(
            question.get("id").and_then(Value::as_str),
            "the pending question",
        );
    }
    for action in &run.actions {
        add(
            action.get("id").and_then(Value::as_str),
            "the affected action",
        );
    }

    let mut replacements = replacements.into_iter().collect::<Vec<_>>();
    replacements.sort_by_key(|(source, _)| std::cmp::Reverse(source.len()));
    replace_display_tokens(message, &replacements)
}

fn collapse_display_whitespace(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn blocker_reason_is_generic(message: &str, kind: &str) -> bool {
    let normalized = message
        .trim_matches(|character: char| character.is_whitespace() || ".:;!?-".contains(character))
        .to_ascii_lowercase();
    normalized.is_empty()
        || (!kind.trim().is_empty() && normalized == kind.trim().to_ascii_lowercase())
        || matches!(
            normalized.as_str(),
            "blocked"
                | "ticket blocked"
                | "ticket is blocked"
                | "work blocked"
                | "work is blocked"
                | "needs attention"
                | "attention required"
                | "error"
                | "failed"
                | "failure"
                | "unknown"
                | "none"
                | "n/a"
        )
}

fn blocker_reason_has_semantic_content(message: &str) -> bool {
    let mut semantic = message.to_ascii_lowercase();
    for placeholder in [
        "the affected graph item",
        "the affected ticket",
        "the affected stage",
        "the affected agent",
        "the pending question",
        "the affected action",
        "this run",
        "a local path",
        "a content hash",
        "an internal record",
        "an internal compiler record",
    ] {
        semantic = semantic.replace(placeholder, " ");
    }
    semantic
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty() && !word.chars().all(|character| character.is_numeric()))
        .any(|word| {
            !matches!(
                word,
                "a" | "an"
                    | "and"
                    | "at"
                    | "attention"
                    | "blocked"
                    | "by"
                    | "compiler"
                    | "error"
                    | "failed"
                    | "failure"
                    | "for"
                    | "from"
                    | "in"
                    | "integration"
                    | "is"
                    | "need"
                    | "needs"
                    | "of"
                    | "on"
                    | "or"
                    | "record"
                    | "required"
                    | "review"
                    | "that"
                    | "the"
                    | "this"
                    | "ticket"
                    | "to"
                    | "validation"
                    | "with"
                    | "work"
                    | "worker"
            )
        })
}

fn redact_embedded_compiler_record(message: &str) -> String {
    let mut rendered = String::with_capacity(message.len());
    let mut copied_through = 0;
    let mut scan_from = 0;
    while let Some((relative, _)) = message[scan_from..]
        .char_indices()
        .find(|(_, character)| matches!(character, '{' | '['))
    {
        let start = scan_from + relative;
        let mut stream = serde_json::Deserializer::from_str(&message[start..]).into_iter::<Value>();
        let Some(Ok(record)) = stream.next() else {
            scan_from = start + message[start..].chars().next().map_or(1, char::len_utf8);
            continue;
        };
        if !record.is_object() && !record.is_array() {
            scan_from = start + stream.byte_offset().max(1);
            continue;
        }
        rendered.push_str(&message[copied_through..start]);
        rendered.push_str("an internal compiler record");
        copied_through = start + stream.byte_offset();
        scan_from = copied_through;
    }
    rendered.push_str(&message[copied_through..]);
    rendered
}

fn wrap_blocker_reason(value: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width: usize = 0;
    for word in value.split_whitespace() {
        let word_width = UnicodeWidthStr::width(word);
        if !current.is_empty() && current_width.saturating_add(1 + word_width) <= width {
            current.push(' ');
            current.push_str(word);
            current_width += 1 + word_width;
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            current_width = 0;
        }
        for character in word.chars() {
            let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
            if !current.is_empty() && current_width.saturating_add(character_width) > width {
                lines.push(std::mem::take(&mut current));
                current_width = 0;
            }
            current.push(character);
            current_width += character_width;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn sanitize_blocker_token(token: &str) -> String {
    let trailing_start = token
        .char_indices()
        .rev()
        .find(|(_, character)| !matches!(character, ',' | '.' | ';' | ':' | '!' | '?'))
        .map_or(0, |(index, character)| index + character.len_utf8());
    let (body, trailing) = token.split_at(trailing_start);
    let body = body.trim_matches(|character: char| {
        matches!(
            character,
            '(' | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '"'
                | '\''
                | '`'
                | '‘'
                | '’'
                | '“'
                | '”'
                | '<'
                | '>'
        )
    });
    let replacement = if blocker_token_is_path(body) {
        Some("a local path")
    } else if blocker_token_is_hash(body) {
        Some("a content hash")
    } else if blocker_token_is_control_id(body) {
        Some("an internal record")
    } else {
        None
    };
    replacement.map_or_else(
        || token.to_owned(),
        |replacement| format!("{replacement}{trailing}"),
    )
}

fn blocker_token_is_path(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    let explicitly_path = ["path=", "path:", "file=", "file:", "worktree=", "worktree:"]
        .iter()
        .any(|marker| lower.contains(marker));
    let value = lower
        .strip_prefix("path=")
        .or_else(|| lower.strip_prefix("path:"))
        .or_else(|| lower.strip_prefix("file="))
        .or_else(|| lower.strip_prefix("file:"))
        .or_else(|| lower.strip_prefix("worktree="))
        .or_else(|| lower.strip_prefix("worktree:"))
        .unwrap_or(&lower);
    explicitly_path || value.contains('/') || value.contains('\\')
}

fn blocker_token_is_hash(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if [
        "sha1:",
        "sha256:",
        "sha512:",
        "blake3:",
        "hash=",
        "hash:",
        "commit=",
        "commit:",
        "digest=",
        "digest:",
        "checksum=",
        "checksum:",
        "oid=",
        "oid:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    let value = lower.strip_prefix("0x").unwrap_or(&lower);
    value.len() >= 7 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn blocker_token_is_control_id(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    let keyed_value = lower
        .split_once(['=', ':'])
        .filter(|(key, _)| key == &"id" || key.ends_with("_id") || key.ends_with("-id"))
        .map(|(_, value)| value);
    if keyed_value.is_some_and(|value| !value.is_empty()) {
        return true;
    }
    blocker_control_id_atom(token)
        || token
            .split(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
            })
            .filter(|segment| !segment.is_empty() && *segment != token)
            .any(blocker_control_id_atom)
}

fn blocker_control_id_atom(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    let value = lower.as_str();
    let uuid_parts = value.split('-').map(str::len).collect::<Vec<_>>();
    if uuid_parts == [8, 4, 4, 4, 12]
        && value
            .chars()
            .filter(|character| *character != '-')
            .all(|character| character.is_ascii_hexdigit())
    {
        return true;
    }
    let opaque_prefix = [
        "agent-",
        "event-",
        "journal-",
        "lease-",
        "output-",
        "question-",
        "receipt-",
        "request-",
        "resolver-",
        "run-",
        "stage-",
        "ticket-",
        "tk-",
    ]
    .iter()
    .find(|prefix| value.starts_with(*prefix));
    let opaque_suffix_len = opaque_prefix.map_or(0, |prefix| value.len() - prefix.len());
    let tagged_id = token.split_once('-').is_some_and(|(prefix, suffix)| {
        (2..=10).contains(&prefix.len())
            && prefix
                .chars()
                .all(|character| character.is_ascii_uppercase())
            && suffix.len() >= 6
    });
    let has_letter = value
        .chars()
        .any(|character| character.is_ascii_alphabetic());
    let has_digit = value.chars().any(|character| character.is_ascii_digit());
    tagged_id
        || (opaque_prefix.is_some() && (has_digit || opaque_suffix_len >= 6))
        || (value.len() >= 16
            && has_letter
            && has_digit
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character)))
}

fn prefixed_detail_lines(
    prefix: &str,
    value: &str,
    width: usize,
    style: Style,
) -> Vec<Line<'static>> {
    let content_width = width.saturating_sub(prefix.chars().count()).max(1);
    wrap_full_text(value, content_width)
        .into_iter()
        .map(|line| Line::styled(format!("{prefix}{line}"), style))
        .collect()
}

fn compact_step_persona(persona: &str) -> String {
    match persona {
        "architecture-mapper" => "Architect".to_owned(),
        "change-designer" => "Designer".to_owned(),
        "contract-designer" => "Contracts".to_owned(),
        "risk-analyst" => "Risk".to_owned(),
        "run-planner" => "Planner".to_owned(),
        _ => humanize(persona),
    }
}

fn completed_step_summary(ticket: &Value, step: &Value, output: Option<&Value>) -> Option<String> {
    if let Some(output) = output {
        for path in [
            &["typed", "summary"][..],
            &["typed", "result_summary"][..],
            &["typed", "outcome"][..],
            &["typed", "message"][..],
            &["summary"][..],
        ] {
            if let Some(summary) = string_path(output, path)
                && !summary.trim().is_empty()
                && let Some(summary) = concise_outcome(summary)
            {
                return Some(summary);
            }
        }
        if let Some(finding) = output
            .get("findings")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .filter(|finding| !finding.trim().is_empty())
            && let Some(finding) = concise_outcome(finding)
        {
            return Some(finding);
        }
        let files = value_len(output.get("files_written")) + value_len(output.get("files_deleted"));
        if files > 0 {
            return Some(format!("Updated {files} project file{}", plural(files)));
        }
        let receipts = value_len(output.get("receipts"));
        if receipts > 0 {
            return Some(format!(
                "Recorded {receipts} verification receipt{}",
                plural(receipts)
            ));
        }
        if let Some(delta) = output_graph_delta(output) {
            let added = value_len(delta.get("add_nodes")) + value_len(delta.get("nodes"));
            let modified = value_len(delta.get("upsert"));
            let deleted = value_len(delta.get("delete"));
            if added > 0 {
                return Some(format!("Added {added} graph node{}", plural(added)));
            }
            if modified > 0 || deleted > 0 || value_len(delta.get("add_edges")) > 0 {
                return Some("Updated the project graph".to_owned());
            }
        }
    }
    let review_step = step.get("kind").and_then(Value::as_str) == Some("review");
    if review_step
        && let Some(review) = ticket
            .get("reviews")
            .and_then(Value::as_array)
            .and_then(|reviews| reviews.last())
        && let Some(status) = review
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| !status.trim().is_empty())
    {
        return Some(format!("Review {}", humanize(status).to_lowercase()));
    }
    None
}

fn concise_outcome(value: &str) -> Option<String> {
    let words = value
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_alphanumeric() && character != '-')
        })
        .filter(|word| !word.is_empty())
        .take(8)
        .collect::<Vec<_>>();
    (!words.is_empty()).then(|| short(&words.join(" "), 58))
}

fn string_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))?
        .as_str()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepVisualState {
    Done,
    Active,
    Failed,
    Ready,
    Pending,
}

#[derive(Debug, Clone)]
struct TicketProgress {
    states: Vec<StepVisualState>,
    done: usize,
    current_persona: Option<String>,
    worker_running: bool,
    worker_failed: bool,
    glyphs: StepGlyphs,
}

#[derive(Debug, Clone)]
struct StepGlyphs {
    done: String,
    active: String,
    pending: String,
}

impl Default for StepGlyphs {
    fn default() -> Self {
        Self {
            done: "●".to_owned(),
            active: "◐".to_owned(),
            pending: "○".to_owned(),
        }
    }
}

impl StepGlyphs {
    fn for_state(&self, state: StepVisualState) -> &str {
        match state {
            StepVisualState::Done => &self.done,
            StepVisualState::Active => &self.active,
            StepVisualState::Failed => "!",
            StepVisualState::Ready | StepVisualState::Pending => &self.pending,
        }
    }
}

fn ticket_progress(ticket: &Value, run: Option<&RunData>) -> TicketProgress {
    let ticket_options = run.and_then(ticket_view_options);
    let glyphs = ticket_options
        .and_then(|options| options.get("step_glyphs"))
        .map(|configured| StepGlyphs {
            done: configured
                .get("done")
                .and_then(Value::as_str)
                .unwrap_or("●")
                .to_owned(),
            active: configured
                .get("active")
                .and_then(Value::as_str)
                .unwrap_or("◐")
                .to_owned(),
            pending: configured
                .get("pending")
                .and_then(Value::as_str)
                .unwrap_or("○")
                .to_owned(),
        })
        .unwrap_or_default();
    let workflow = ticket
        .get("workflow")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ticket_id = ticket.get("id").and_then(Value::as_str).unwrap_or_default();
    let compiled = run
        .and_then(|run| run.snapshot.get("board"))
        .and_then(|board| board.get("ticket_workflows"))
        .and_then(|workflows| workflows.get(ticket_id));
    let completed = compiled
        .and_then(|progress| progress.get("completed_steps"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let ready = compiled
        .and_then(|progress| progress.get("ready_steps"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let worker_state = compiled
        .and_then(|progress| progress.get("worker_state"))
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let reported_worker_running = worker_state == "running";
    let reported_worker_failed = worker_state == "exited_before_output";
    let closed = ticket_is_closed(ticket);
    let successfully_closed = ticket_completed_successfully(ticket);
    let worker_running = reported_worker_running && !closed;
    let worker_failed = reported_worker_failed && !closed;
    let assigned_step = compiled
        .and_then(|progress| progress.get("active_worker_step"))
        .and_then(Value::as_str);
    let active_step = worker_running.then_some(assigned_step).flatten();
    let failed_step = worker_failed.then_some(assigned_step).flatten();
    let review_complete = compiled
        .and_then(|progress| progress.get("review_status"))
        .and_then(Value::as_str)
        == Some("passed");
    let states = workflow
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let id = step.get("id").and_then(Value::as_str).unwrap_or_default();
            let review_step = step.get("kind").and_then(Value::as_str) == Some("review");
            if completed.contains(&id)
                || (review_step && review_complete)
                || (compiled.is_none() && successfully_closed)
            {
                StepVisualState::Done
            } else if active_step == Some(id) {
                StepVisualState::Active
            } else if failed_step == Some(id) {
                StepVisualState::Failed
            } else if ready.contains(&id) || (compiled.is_none() && !closed && index == 0) {
                StepVisualState::Ready
            } else {
                StepVisualState::Pending
            }
        })
        .collect::<Vec<_>>();
    let current_persona = states
        .iter()
        .position(|state| *state == StepVisualState::Active)
        .or_else(|| {
            states
                .iter()
                .position(|state| *state == StepVisualState::Failed)
        })
        .or_else(|| {
            states
                .iter()
                .position(|state| *state == StepVisualState::Ready)
        })
        .and_then(|index| workflow.get(index))
        .and_then(|step| step.get("persona"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    TicketProgress {
        done: states
            .iter()
            .filter(|state| **state == StepVisualState::Done)
            .count(),
        states,
        current_persona,
        worker_running,
        worker_failed,
        glyphs,
    }
}

fn ticket_view_options(run: &RunData) -> Option<&Value> {
    run.snapshot
        .get("views")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|view| {
            view.get("kind").and_then(Value::as_str) == Some("tabbed_table")
                || view
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.contains("ticket"))
        })
        .and_then(|view| view.get("options"))
}

fn workflow_rail_spans(states: &[StepVisualState], glyphs: &StepGlyphs) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for (index, state) in states.iter().copied().enumerate() {
        if index > 0 {
            spans.push(Span::styled("─", Style::default().fg(Color::DarkGray)));
        }
        spans.push(Span::styled(
            glyphs.for_state(state).to_owned(),
            Style::default().fg(step_color(state)).add_modifier(
                if state == StepVisualState::Active {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                },
            ),
        ));
    }
    spans
}

fn step_color(state: StepVisualState) -> Color {
    match state {
        StepVisualState::Done => Color::Green,
        StepVisualState::Active => Color::Yellow,
        StepVisualState::Failed => Color::LightRed,
        StepVisualState::Ready => Color::Cyan,
        StepVisualState::Pending => Color::DarkGray,
    }
}

fn step_label(state: StepVisualState) -> &'static str {
    match state {
        StepVisualState::Done => "done",
        StepVisualState::Active => "working",
        StepVisualState::Failed => "needs recovery",
        StepVisualState::Ready => "ready",
        StepVisualState::Pending => "waiting",
    }
}

fn run_overview_text(
    run: &RunData,
    summary: &RunSummary,
    run_type_title: &str,
    model: &ControlCenterModel,
) -> Text<'static> {
    let closed = run
        .tickets
        .iter()
        .filter(|ticket| ticket_is_closed(ticket))
        .count();
    let active = run
        .tickets
        .iter()
        .filter(|ticket| {
            matches!(
                ticket.get("status").and_then(Value::as_str),
                Some("active" | "in_progress" | "leased" | "review" | "integrating")
            )
        })
        .count();
    let blocked = run
        .tickets
        .iter()
        .filter(|ticket| value_len(ticket.get("blockers")) > 0)
        .count();
    let workers = run.live_agent_summaries().len();
    let failed_workers = run
        .tickets
        .iter()
        .filter(|ticket| ticket_progress(ticket, Some(run)).worker_failed)
        .count();
    let mut progress = Vec::new();
    let bar_width = 12_usize;
    let filled = (closed * bar_width)
        .checked_div(summary.ticket_count)
        .unwrap_or_default();
    progress.push(Span::styled(
        "━".repeat(filled),
        Style::default().fg(Color::Green),
    ));
    progress.push(Span::styled(
        "─".repeat(bar_width - filled),
        Style::default().fg(Color::DarkGray),
    ));
    let status_marker = if workers > 0 {
        Span::styled("⚙ ", live_activity_style(model))
    } else {
        Span::styled(
            format!("{} ", status_glyph(&summary.status)),
            Style::default()
                .fg(status_color(&summary.status))
                .add_modifier(Modifier::BOLD),
        )
    };
    let mut lines = vec![
        Line::from(vec![
            status_marker,
            Span::styled(
                format!(" {} ", humanize(&summary.status)),
                Style::default()
                    .fg(Color::Black)
                    .bg(status_color(&summary.status))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {run_type_title}"),
                Style::default().fg(Color::LightBlue),
            ),
        ]),
        Line::raw(""),
        Line::styled("Progress", heading_style()),
        Line::from(progress),
        Line::styled(
            format!("{closed}/{} tickets complete", summary.ticket_count),
            Style::default().fg(Color::DarkGray),
        ),
        Line::raw(""),
        Line::styled("At a glance", heading_style()),
        Line::raw(format!("● {closed} complete    ◐ {active} active")),
        Line::from(vec![
            Span::raw(format!(
                "! {blocked} blocked · {failed_workers} recovery    "
            )),
            Span::styled(
                if workers > 0 { "⚙" } else { "○" },
                if workers > 0 {
                    live_activity_style(model)
                } else {
                    Style::default().fg(Color::DarkGray)
                },
            ),
            Span::raw(format!(" {workers} working")),
        ]),
        Line::raw(format!(
            "◇ {} graph nodes  ? {} open questions",
            run.graph.len(),
            summary.open_questions
        )),
    ];
    let tokens = run.token_breakdown();
    if tokens.new > 0 || tokens.cached_input > 0 || run.planning_budget_progress().is_some() {
        let uncached_input = tokens.input.saturating_sub(tokens.cached_input);
        lines.extend([
            Line::raw(""),
            Line::styled("Model usage", heading_style()),
            Line::from(vec![
                Span::styled(
                    compact_token_count(tokens.new),
                    Style::default().fg(Color::LightMagenta),
                ),
                Span::styled(
                    " new · cache excluded",
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            Line::styled(
                format!(
                    "Uncached input {} · output {} · reasoning {}",
                    compact_token_count(uncached_input),
                    compact_token_count(tokens.output),
                    compact_token_count(tokens.reasoning_output)
                ),
                Style::default().fg(Color::DarkGray),
            ),
            Line::styled(
                format!(
                    "Cached input {} · provider total {}",
                    compact_token_count(tokens.cached_input),
                    compact_token_count(tokens.total)
                ),
                Style::default().fg(Color::DarkGray),
            ),
        ]);
        if let Some(progress) = run.planning_budget_progress() {
            let synthesis_at = progress.limit.saturating_sub(progress.synthesis_reserve);
            lines.push(Line::from(vec![
                Span::styled("Planning budget  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    format!(
                        "{} / {} {}",
                        compact_token_count(progress.used),
                        compact_token_count(progress.limit),
                        progress.metric.label()
                    ),
                    Style::default().fg(if progress.synthesis_forced {
                        Color::Yellow
                    } else {
                        Color::Cyan
                    }),
                ),
                Span::styled(
                    format!(
                        " · synthesis reserve at {}",
                        compact_token_count(synthesis_at)
                    ),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
    }
    Text::from(lines)
}

fn planning_timeline(items: &[Value], stages: &[Value], width: usize) -> Text<'static> {
    // Consecutive identical projections are transport retries or repeated tool failures, not
    // distinct operator decisions. Keep their count without letting them dominate the viewport.
    let mut groups = Vec::<(String, Vec<(String, String, usize)>)>::new();
    for item in items {
        if item
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.starts_with("planning.question."))
        {
            // Pending decisions have one dedicated interactive surface. Once resolved, their
            // durable audit records remain on disk without becoming a second question-history UI.
            continue;
        }
        let Some(summary) = planning_event_summary(item) else {
            continue;
        };
        let stage = planning_event_stage_title(item, stages);
        let timestamp = planning_event_timestamp(item);
        if let Some((_, rows)) = groups.iter_mut().find(|(title, _)| title == &stage) {
            if let Some((_, _, count)) = rows
                .last_mut()
                .filter(|(_, previous, _)| previous == &summary)
            {
                *count += 1;
            } else {
                rows.push((timestamp, summary, 1));
            }
        } else {
            groups.push((stage, vec![(timestamp, summary, 1)]));
        }
    }

    if groups.is_empty() {
        return Text::from("No operator-facing planning events yet.");
    }

    let mut lines = Vec::new();
    let text_column = 12usize;
    let event_width = width.saturating_sub(text_column).max(1);
    for (group_index, (stage, rows)) in groups.into_iter().enumerate() {
        if group_index > 0 {
            lines.push(Line::raw(""));
        }
        lines.push(Line::styled(
            stage,
            Style::default()
                .fg(Color::Gray)
                .add_modifier(Modifier::BOLD),
        ));
        for (timestamp, summary, count) in rows {
            let summary = if count > 1 {
                format!("{summary} ×{count}")
            } else {
                summary
            };
            for (line_index, line) in wrap_full_text(&summary, event_width)
                .into_iter()
                .enumerate()
            {
                if line_index == 0 {
                    lines.push(Line::from(vec![
                        Span::styled(
                            format!("  {timestamp:<8}  "),
                            Style::default().fg(Color::DarkGray),
                        ),
                        Span::styled(line, Style::default().fg(Color::Gray)),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::raw(" ".repeat(text_column)),
                        Span::styled(line, Style::default().fg(Color::Gray)),
                    ]));
                }
            }
        }
    }
    Text::from(lines)
}

fn planning_event_stage_title(item: &Value, stages: &[Value]) -> String {
    let Some(stage_id) = item.get("stage_id").and_then(Value::as_str) else {
        return "Run setup".to_owned();
    };
    stages
        .iter()
        .find_map(|stage| {
            let definition = stage.get("definition").unwrap_or(stage);
            (definition.get("id").and_then(Value::as_str) == Some(stage_id))
                .then(|| definition.get("title").and_then(Value::as_str))
                .flatten()
        })
        .filter(|title| !title.trim().is_empty())
        .map(str::trim)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| humanize(stage_id))
}

fn planning_event_timestamp(item: &Value) -> String {
    let raw = ["at", "timestamp", "created_at"]
        .into_iter()
        .find_map(|field| item.get(field).and_then(Value::as_str))
        .or_else(|| {
            let event = item.get("event")?;
            ["at", "timestamp", "created_at"]
                .into_iter()
                .find_map(|field| event.get(field).and_then(Value::as_str))
        });
    raw.map(compact_planning_timestamp)
        .unwrap_or_else(|| "--:--:--".to_owned())
}

fn compact_planning_timestamp(value: &str) -> String {
    let value = value.trim();
    let clock = value
        .split_once('T')
        .map(|(_, clock)| clock)
        .unwrap_or(value);
    let clock = clock.trim_start_matches(|character: char| character.is_whitespace());
    if clock.len() >= 8
        && clock.as_bytes().get(2) == Some(&b':')
        && clock.as_bytes().get(5) == Some(&b':')
    {
        clock[..8].to_owned()
    } else {
        short(value, 8)
    }
}

/// Turn the nested Codex JSONL stream into a quiet operator-facing timeline. The durable
/// transcript retains raw commands and transport envelopes; this projection only keeps events
/// that help a person understand planning progress.
fn planning_event_summary(item: &Value) -> Option<String> {
    let event_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match event_type {
        "planning.intake" => Some("Captured objective and run settings".to_owned()),
        "planning.compiler_stage.completed" => Some("Compiler checks passed".to_owned()),
        "pipeline.approval_stage.completed" => Some("Run approved".to_owned()),
        "planning.agent.starting" => Some("Started planning pass".to_owned()),
        "planning.agent.resuming" => Some("Resumed planning pass".to_owned()),
        "planning.agent.paused" => Some("Paused planning pass".to_owned()),
        "planning.agent.interrupted" => Some("Planning pass interrupted".to_owned()),
        "planning.agent.process_error" => Some(with_planning_detail(
            "Planning process failed",
            item.get("error").and_then(Value::as_str),
        )),
        "planning.agent.completed" | "planning.agent.finished" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            Some(format!("Planning pass {}", humanize(status).to_lowercase()))
        }
        "planning.output" => Some("Recorded plan".to_owned()),
        "pipeline.initialization_stage.completed" => Some("Initialized run".to_owned()),
        "planning.budget.synthesis_forced" => {
            Some("Entered synthesis reserve to finish the plan".to_owned())
        }
        "planning.revision.requested" => Some(with_planning_detail(
            "Revision requested",
            item.get("instructions").and_then(Value::as_str),
        )),
        "planning.agent.event" => project_nested_planning_event(item),
        other => {
            let detail = ["summary", "message", "content", "text"]
                .into_iter()
                .find_map(|field| item.get(field).and_then(Value::as_str));
            detail.map(|detail| {
                with_planning_detail(
                    if other.is_empty() {
                        "Planning update".to_owned()
                    } else {
                        humanize(other)
                    },
                    Some(detail),
                )
            })
        }
    }
}

fn project_nested_planning_event(item: &Value) -> Option<String> {
    let event = item.get("event").unwrap_or(&Value::Null);
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let nested = event.get("item").unwrap_or(&Value::Null);
    let nested_type = nested
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (event_type, nested_type) {
        ("thread.started", _) => Some("Connected planning session".to_owned()),
        ("turn.started", _) => Some("Started reasoning".to_owned()),
        ("turn.completed" | "turn.finished", _) => {
            let usage = event.get("usage").unwrap_or(&Value::Null);
            let total = usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or_default()
                .saturating_add(
                    usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                );
            Some(if total > 0 {
                format!("Finished reasoning · {} used", compact_token_count(total))
            } else {
                "Finished reasoning".to_owned()
            })
        }
        // Started items and usage ticks dominate Codex's raw JSONL. The durable transcript and
        // selected-agent chat retain them; this overview waits for their meaningful outcome.
        ("token.usage.updated", _) | ("item.started", _) => None,
        ("item.completed", "command_execution") => {
            let exit = nested.get("exit_code").and_then(Value::as_i64);
            (exit != Some(0)).then(|| {
                exit.map_or_else(
                    || "A project inspection command failed".to_owned(),
                    |code| format!("A project inspection command failed (exit {code})"),
                )
            })
        }
        ("item.completed", "userMessage" | "user_message") => None,
        ("item.completed", "agent_message") => nested
            .get("text")
            .and_then(Value::as_str)
            .map(planning_agent_message_summary),
        ("item.completed", "reasoning" | "reasoning_summary") => planning_reasoning_summary(nested)
            .map(|text| with_planning_detail("Reasoned", Some(&text))),
        _ => {
            let detail = nested
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| event.get("message").and_then(Value::as_str))
                .or_else(|| event.get("error").and_then(Value::as_str));
            detail.map(|detail| {
                with_planning_detail(
                    humanize(if nested_type.is_empty() {
                        event_type
                    } else {
                        nested_type
                    }),
                    Some(detail),
                )
            })
        }
    }
}

/// Codex exposes optional reasoning *summaries* as strings or structured text fragments. These
/// are suitable for an operator timeline; empty arrays and raw reasoning content are deliberately
/// ignored so the control center never invents a thought-process transcript.
fn planning_reasoning_summary(item: &Value) -> Option<String> {
    fn collect(value: &Value, output: &mut Vec<String>) {
        match value {
            Value::String(text) if !text.trim().is_empty() => output.push(text.trim().to_owned()),
            Value::Array(values) => {
                for value in values {
                    collect(value, output);
                }
            }
            Value::Object(object) => {
                for field in ["text", "summary"] {
                    if let Some(value) = object.get(field) {
                        collect(value, output);
                    }
                }
            }
            _ => {}
        }
    }

    let mut fragments = Vec::new();
    if let Some(summary) = item.get("summary") {
        collect(summary, &mut fragments);
    }
    (!fragments.is_empty()).then(|| short(&fragments.join(" "), 220))
}

fn with_planning_detail(label: impl Into<String>, detail: Option<&str>) -> String {
    let label = label.into();
    detail
        .map(str::trim)
        .filter(|detail| !detail.is_empty())
        .map(|detail| format!("{label} — {}", short(detail, 220)))
        .unwrap_or(label)
}

fn planning_agent_message_summary(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("questions")
                .and_then(Value::as_array)
                .filter(|questions| !questions.is_empty())
                .map(|_| "Planning paused for input; use the Questions panel.".to_owned())
                .or_else(|| {
                    ["summary", "message", "plan", "content", "prompt"]
                        .into_iter()
                        .find_map(|field| value.get(field).and_then(Value::as_str))
                        .map(|summary| short(summary, 220))
                })
        })
        .unwrap_or_else(|| short(text, 220))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvidenceBasis {
    TicketResult,
    PassedReview,
    Verification,
    FinalReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvidenceHealth {
    Attention,
    Recorded(EvidenceBasis),
    NoRecordedIssues,
}

fn evidence_health(run: &RunData, summary: &RunSummary) -> EvidenceHealth {
    let blocked = run
        .tickets
        .iter()
        .any(|ticket| value_len(ticket.get("blockers")) > 0);
    let board = run.snapshot.get("board");
    let workflow_rows = board
        .and_then(|board| board.get("ticket_workflows"))
        .and_then(Value::as_object);
    let failed_worker = workflow_rows.is_some_and(|rows| {
        rows.values().any(|progress| {
            progress.get("worker_state").and_then(Value::as_str) == Some("exited_before_output")
        })
    });
    let failed_review = workflow_rows.is_some_and(|rows| {
        rows.values()
            .any(|progress| progress.get("review_status").and_then(Value::as_str) == Some("failed"))
    });
    let failed_pipeline = run.stages.iter().any(|stage| {
        matches!(
            stage.get("status").and_then(Value::as_str),
            Some("failed" | "blocked")
        )
    });
    let failed_ticket = run.tickets.iter().any(|ticket| {
        matches!(
            ticket.get("status").and_then(Value::as_str),
            Some("failed" | "blocked")
        )
    });
    let recorded_issue = summary.validation_errors > 0
        || matches!(summary.status.as_str(), "failed" | "blocked")
        || blocked
        || failed_worker
        || failed_review
        || failed_pipeline
        || failed_ticket
        || board.is_some_and(|board| {
            value_len(board.get("failed_journals")) > 0
                || value_len(board.get("incomplete_journals")) > 0
                || value_len(board.get("incomplete_integrations")) > 0
        });
    if recorded_issue {
        return EvidenceHealth::Attention;
    }
    if !health_telemetry_complete(run) {
        return EvidenceHealth::NoRecordedIssues;
    }
    recorded_evidence_basis(run)
        .map(EvidenceHealth::Recorded)
        .unwrap_or(EvidenceHealth::NoRecordedIssues)
}

fn health_telemetry_complete(run: &RunData) -> bool {
    if run
        .snapshot
        .get("validation_errors")
        .and_then(Value::as_array)
        .is_none()
    {
        return false;
    }
    if run
        .snapshot
        .get("stages")
        .and_then(Value::as_array)
        .is_none()
    {
        return false;
    }
    let Some(board) = run.snapshot.get("board").and_then(Value::as_object) else {
        return false;
    };
    if [
        "failed_journals",
        "incomplete_journals",
        "incomplete_integrations",
    ]
    .into_iter()
    .any(|field| board.get(field).and_then(Value::as_array).is_none())
    {
        return false;
    }
    let Some(workflows) = board.get("ticket_workflows").and_then(Value::as_object) else {
        return false;
    };
    let Some(tickets) = run.snapshot.get("tickets").and_then(Value::as_array) else {
        return false;
    };
    tickets.iter().all(|ticket| {
        let Some(ticket_id) = ticket.get("id").and_then(Value::as_str) else {
            return false;
        };
        if ticket.get("blockers").and_then(Value::as_array).is_none()
            || ticket.get("workflow").and_then(Value::as_array).is_none()
        {
            return false;
        }
        let Some(progress) = workflows.get(ticket_id).and_then(Value::as_object) else {
            return false;
        };
        progress.get("status").and_then(Value::as_str).is_some()
            && ["completed_steps", "ready_steps", "pending_steps"]
                .into_iter()
                .all(|field| {
                    progress
                        .get(field)
                        .and_then(Value::as_array)
                        .is_some_and(|steps| steps.iter().all(|step| step.as_str().is_some()))
                })
            && progress
                .get("worker_state")
                .and_then(Value::as_str)
                .is_some_and(|state| {
                    matches!(
                        state,
                        "idle" | "running" | "completed" | "exited_before_output"
                    )
                })
            && progress
                .get("active_worker_step")
                .is_some_and(|value| value.is_null() || value.as_str().is_some())
            && progress.get("review_status").is_some_and(|value| {
                value.is_null() || matches!(value.as_str(), Some("passed" | "failed"))
            })
    })
}

fn recorded_evidence_basis(run: &RunData) -> Option<EvidenceBasis> {
    if successful_pipeline_evidence(run, EvidenceBasis::FinalReport) {
        return Some(EvidenceBasis::FinalReport);
    }
    if successful_pipeline_evidence(run, EvidenceBasis::Verification) {
        return Some(EvidenceBasis::Verification);
    }
    if compiler_projects_current_passed_review(run) {
        return Some(EvidenceBasis::PassedReview);
    }
    run.tickets
        .iter()
        .any(|ticket| {
            ticket
                .get("outputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| outputs.iter().any(Value::is_object))
        })
        .then_some(EvidenceBasis::TicketResult)
}

fn compiler_projects_current_passed_review(run: &RunData) -> bool {
    let Some(workflows) = run
        .snapshot
        .get("board")
        .and_then(|board| board.get("ticket_workflows"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    run.tickets.iter().any(|ticket| {
        let review_steps = ticket
            .get("workflow")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|step| step.get("kind").and_then(Value::as_str) == Some("review"))
            .filter_map(|step| step.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        if review_steps.is_empty() {
            return false;
        }
        let Some(progress) = ticket
            .get("id")
            .and_then(Value::as_str)
            .and_then(|ticket_id| workflows.get(ticket_id))
        else {
            return false;
        };
        let pending = progress
            .get("pending_steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<BTreeSet<_>>();
        progress.get("review_status").and_then(Value::as_str) == Some("passed")
            && review_steps
                .into_iter()
                .all(|step_id| !pending.contains(step_id))
    })
}

fn successful_pipeline_evidence(run: &RunData, basis: EvidenceBasis) -> bool {
    run.stages.iter().any(|stage| {
        if stage.get("status").and_then(Value::as_str) != Some("succeeded")
            || stage.get("output").is_none_or(Value::is_null)
        {
            return false;
        }
        let config = stage
            .get("definition")
            .and_then(|definition| definition.get("config"));
        match basis {
            EvidenceBasis::Verification => {
                config
                    .and_then(|config| config.get("checkpoint"))
                    .and_then(Value::as_str)
                    == Some("verification")
            }
            EvidenceBasis::FinalReport => {
                config
                    .and_then(|config| config.get("action"))
                    .and_then(Value::as_str)
                    == Some("report")
            }
            EvidenceBasis::TicketResult | EvidenceBasis::PassedReview => false,
        }
    })
}

fn evidence_basis_detail(basis: EvidenceBasis) -> &'static str {
    match basis {
        EvidenceBasis::TicketResult => "✓ Ticket result recorded · no known issues",
        EvidenceBasis::PassedReview => "✓ Review passed · no known issues",
        EvidenceBasis::Verification => "✓ Verification recorded · no known issues",
        EvidenceBasis::FinalReport => "✓ Final report recorded · no known issues",
    }
}

fn final_report_status(run: &RunData) -> &'static str {
    if successful_pipeline_evidence(run, EvidenceBasis::FinalReport) {
        "Final report recorded."
    } else if run.report.is_some() {
        "No final report yet."
    } else {
        "No final report configured."
    }
}

fn report_text(
    run: &RunData,
    visible_graph_nodes: usize,
    model: &ControlCenterModel,
    compact: bool,
) -> Text<'static> {
    let Some(summary) = run.summary.as_ref() else {
        return Text::from("No run status available.");
    };
    let closed = run
        .tickets
        .iter()
        .filter(|ticket| ticket_is_closed(ticket))
        .count();
    let active = run
        .tickets
        .iter()
        .filter(|ticket| {
            matches!(
                ticket.get("status").and_then(Value::as_str),
                Some("active" | "in_progress" | "leased" | "review" | "integrating")
            )
        })
        .count();
    let todo = run
        .tickets
        .iter()
        .filter(|ticket| {
            matches!(
                ticket.get("status").and_then(Value::as_str),
                Some("todo" | "ready" | "queued" | "proposed")
            )
        })
        .count();
    let blocked = run
        .tickets
        .iter()
        .filter(|ticket| value_len(ticket.get("blockers")) > 0)
        .count();
    let workers = run.live_agent_summaries().len();
    let board = run.snapshot.get("board");
    let workflow_rows = board
        .and_then(|board| board.get("ticket_workflows"))
        .and_then(Value::as_object);
    let failed_workers = workflow_rows.map_or(0, |rows| {
        rows.values()
            .filter(|progress| {
                progress.get("worker_state").and_then(Value::as_str) == Some("exited_before_output")
            })
            .count()
    });
    let failed_reviews = workflow_rows.map_or(0, |rows| {
        rows.values()
            .filter(|progress| {
                progress.get("review_status").and_then(Value::as_str) == Some("failed")
            })
            .count()
    });
    let failed_stages = run
        .stages
        .iter()
        .filter(|stage| {
            matches!(
                stage.get("status").and_then(Value::as_str),
                Some("failed" | "blocked")
            )
        })
        .count();
    let failed_tickets = run
        .tickets
        .iter()
        .filter(|ticket| ticket.get("status").and_then(Value::as_str) == Some("failed"))
        .count();
    let blocked_ticket_states_without_reason = run
        .tickets
        .iter()
        .filter(|ticket| {
            ticket.get("status").and_then(Value::as_str) == Some("blocked")
                && value_len(ticket.get("blockers")) == 0
        })
        .count();
    let failed_actions = board.map_or(0, |board| value_len(board.get("failed_journals")));
    let interrupted_actions = board.map_or(0, |board| value_len(board.get("incomplete_journals")));
    let interrupted_integrations =
        board.map_or(0, |board| value_len(board.get("incomplete_integrations")));
    let health = evidence_health(run, summary);
    let health_badge = match health {
        EvidenceHealth::Attention => Span::styled(
            " ! ATTENTION ",
            Style::default()
                .fg(Color::Black)
                .bg(Color::LightRed)
                .add_modifier(Modifier::BOLD),
        ),
        EvidenceHealth::Recorded(_) => Span::styled(
            " ● Evidence recorded ",
            Style::default()
                .fg(Color::Black)
                .bg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        EvidenceHealth::NoRecordedIssues => Span::styled(
            " ◇ No recorded issues ",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        ),
    };
    let health_line = Line::from(vec![
        health_badge,
        Span::styled(
            format!("  {}", humanize(&summary.status)),
            Style::default().fg(status_color(&summary.status)),
        ),
    ]);
    if compact {
        let mut lines = vec![
            health_line,
            Line::from(vec![
                Span::styled(
                    format!("● {closed} done"),
                    Style::default().fg(Color::Green),
                ),
                Span::styled("  ·  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    format!("◐ {active} active"),
                    Style::default().fg(Color::Yellow),
                ),
                Span::styled("  ·  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    format!("○ {todo} waiting"),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
        ];
        match health {
            EvidenceHealth::Recorded(basis) => lines.push(Line::styled(
                evidence_basis_detail(basis),
                Style::default().fg(Color::Green),
            )),
            EvidenceHealth::NoRecordedIssues => lines.push(Line::styled(
                "◇ Evidence pending",
                Style::default().fg(Color::DarkGray),
            )),
            EvidenceHealth::Attention => {
                if blocked > 0 {
                    lines.push(Line::styled(
                        format!("! {blocked} blocked ticket{}", plural(blocked)),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if failed_tickets > 0 {
                    lines.push(Line::styled(
                        format!("! {failed_tickets} failed ticket{}", plural(failed_tickets)),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if blocked_ticket_states_without_reason > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {blocked_ticket_states_without_reason} blocked ticket state{}",
                            plural(blocked_ticket_states_without_reason)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if failed_workers > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {failed_workers} worker{} need recovery",
                            plural(failed_workers)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if failed_reviews > 0 {
                    lines.push(Line::styled(
                        format!("! {failed_reviews} review{} failed", plural(failed_reviews)),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if failed_stages > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {failed_stages} pipeline stage{} failed or blocked",
                            plural(failed_stages)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if failed_actions > 0 {
                    lines.push(Line::styled(
                        format!("! {failed_actions} failed action{}", plural(failed_actions)),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if interrupted_actions > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {interrupted_actions} interrupted action{}",
                            plural(interrupted_actions)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if interrupted_integrations > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {interrupted_integrations} interrupted integration{}",
                            plural(interrupted_integrations)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
                if summary.validation_errors > 0 {
                    lines.push(Line::styled(
                        format!(
                            "! {} validation issue{}",
                            summary.validation_errors,
                            plural(summary.validation_errors)
                        ),
                        Style::default().fg(Color::LightRed),
                    ));
                }
            }
        }
        lines.extend([
            Line::from(vec![
                Span::styled(
                    if workers > 0 { "⚙ " } else { "○ " },
                    if workers > 0 {
                        live_activity_style(model)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
                Span::styled(
                    format!("{workers} working"),
                    Style::default().fg(if workers > 0 {
                        Color::Yellow
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::styled(
                    format!(
                        " · ◇{visible_graph_nodes} nodes · ?{} questions",
                        summary.open_questions
                    ),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            Line::styled(
                final_report_status(run),
                Style::default().fg(Color::DarkGray),
            ),
        ]);
        return Text::from(lines);
    }
    let mut lines = vec![health_line];
    match health {
        EvidenceHealth::Recorded(basis) => lines.push(Line::styled(
            evidence_basis_detail(basis),
            Style::default().fg(Color::Green),
        )),
        EvidenceHealth::NoRecordedIssues => lines.push(Line::styled(
            "◇ Evidence pending",
            Style::default().fg(Color::DarkGray),
        )),
        EvidenceHealth::Attention => {}
    }
    lines.extend([
        Line::raw(""),
        Line::styled("Tickets", heading_style()),
        Line::raw(format!("● {closed} complete")),
        Line::raw(format!("◐ {active} active")),
        Line::raw(format!("○ {todo} waiting")),
    ]);
    if blocked > 0 {
        lines.push(Line::styled(
            format!("! {blocked} blocked"),
            Style::default().fg(Color::LightRed),
        ));
    }
    if failed_tickets > 0 {
        lines.push(Line::styled(
            format!("! {failed_tickets} failed ticket{}", plural(failed_tickets)),
            Style::default().fg(Color::LightRed),
        ));
    }
    if blocked_ticket_states_without_reason > 0 {
        lines.push(Line::styled(
            format!(
                "! {blocked_ticket_states_without_reason} blocked ticket state{}",
                plural(blocked_ticket_states_without_reason)
            ),
            Style::default().fg(Color::LightRed),
        ));
    }
    lines.extend([
        Line::raw(""),
        Line::styled("System", heading_style()),
        Line::from(vec![
            Span::styled(
                if workers > 0 { "⚙ " } else { "○ " },
                if workers > 0 {
                    live_activity_style(model)
                } else {
                    Style::default().fg(Color::DarkGray)
                },
            ),
            Span::raw(format!("{workers} active worker{}", plural(workers))),
        ]),
    ]);
    if failed_workers > 0 {
        lines.push(Line::styled(
            format!(
                "! {failed_workers} worker{} need recovery",
                plural(failed_workers)
            ),
            Style::default().fg(Color::LightRed),
        ));
    }
    if failed_reviews > 0 {
        lines.push(Line::styled(
            format!("! {failed_reviews} review{} failed", plural(failed_reviews)),
            Style::default().fg(Color::LightRed),
        ));
    }
    if failed_stages > 0 {
        lines.push(Line::styled(
            format!(
                "! {failed_stages} pipeline stage{} failed or blocked",
                plural(failed_stages)
            ),
            Style::default().fg(Color::LightRed),
        ));
    }
    if failed_actions > 0 {
        lines.push(Line::styled(
            format!("! {failed_actions} failed action{}", plural(failed_actions)),
            Style::default().fg(Color::LightRed),
        ));
    }
    if interrupted_actions > 0 {
        lines.push(Line::styled(
            format!(
                "! {interrupted_actions} interrupted action{}",
                plural(interrupted_actions),
            ),
            Style::default().fg(Color::Yellow),
        ));
    }
    if interrupted_integrations > 0 {
        lines.push(Line::styled(
            format!(
                "! {interrupted_integrations} interrupted integration{}",
                plural(interrupted_integrations)
            ),
            Style::default().fg(Color::Yellow),
        ));
    }
    lines.extend([
        Line::raw(format!("◇ {visible_graph_nodes} graph nodes")),
        Line::raw(format!(
            "? {} open question{}",
            summary.open_questions,
            plural(summary.open_questions)
        )),
    ]);
    if summary.validation_errors > 0 {
        lines.push(Line::styled(
            format!(
                "! {} validation issue{}",
                summary.validation_errors,
                plural(summary.validation_errors)
            ),
            Style::default().fg(Color::LightRed),
        ));
    }
    lines.extend([
        Line::raw(""),
        Line::styled(
            final_report_status(run),
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    Text::from(lines)
}

fn draw_configure(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let layout = configure_layout(area);
    if let Some(draft_bar) = layout.draft_bar {
        draw_configure_draft_bar(frame, model, draft_bar);
    }
    draw_config_domains(frame, model, layout.domains);
    draw_config_resources(frame, model, layout.resources);
    draw_config_editor(frame, model, layout.editor);
}

pub(crate) fn configure_domain_at(
    _model: &ControlCenterModel,
    column: u16,
    row: u16,
    area: Rect,
) -> Option<usize> {
    let domains = configure_layout(area).domains;
    if !rect_contains(domains, column, row) || row == domains.y {
        return None;
    }
    let index = usize::from(
        row.saturating_sub(domains.y.saturating_add(1)) / CONFIG_DOMAIN_ROW_HEIGHT.max(1),
    );
    (index < ConfigDomain::ALL.len()).then_some(index)
}

pub(crate) fn configure_resource_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    area: Rect,
) -> Option<usize> {
    let resources_area = configure_layout(area).resources;
    if !rect_contains(resources_area, column, row) || row == resources_area.y {
        return None;
    }
    let resources = model.config.domain_resources().collect::<Vec<_>>();
    let (first, visible) = configure_resource_window(model, resources_area, resources.len());
    let offset = usize::from(
        row.saturating_sub(resources_area.y.saturating_add(1)) / CONFIG_RESOURCE_CARD_HEIGHT.max(1),
    );
    let index = first.saturating_add(offset);
    (offset < visible && index < resources.len()).then_some(index)
}

pub(crate) fn configure_field_at(
    model: &ControlCenterModel,
    column: u16,
    row: u16,
    area: Rect,
) -> Option<usize> {
    let editor = configure_layout(area).editor;
    let resource = model.config.selected_resource()?;
    if model.config.linked_document_editor_active()
        || model.config.selected_domain() == ConfigDomain::Advanced
        || resource.is_raw_source()
    {
        return None;
    }
    let inner = Rect::new(
        editor.x.saturating_add(1),
        editor.y.saturating_add(1),
        editor.width.saturating_sub(2),
        editor.height.saturating_sub(2),
    );
    let header_height = guided_editor_header_height(
        model,
        model.config.selected_domain(),
        usize::from(inner.width),
    );
    let fields = Rect::new(
        inner.x,
        inner.y.saturating_add(header_height),
        inner.width,
        inner.height.saturating_sub(header_height),
    );
    if !rect_contains(fields, column, row) {
        return None;
    }
    let (first, visible) = configure_field_window(model, fields, model.config.form_rows.len());
    let offset = usize::from(row.saturating_sub(fields.y) / 2);
    let index = first.saturating_add(offset);
    (offset < visible && index < model.config.form_rows.len()).then_some(index)
}

fn rect_contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x && column < area.right() && row >= area.y && row < area.bottom()
}

fn configure_resource_window(
    model: &ControlCenterModel,
    area: Rect,
    resource_count: usize,
) -> (usize, usize) {
    if resource_count == 0 {
        return (0, 0);
    }
    let capacity =
        usize::from(area.height.saturating_sub(2) / CONFIG_RESOURCE_CARD_HEIGHT.max(1)).max(1);
    let selected = model
        .config
        .selected_resource
        .min(resource_count.saturating_sub(1));
    let first = selected
        .saturating_sub(capacity.saturating_sub(1) / 2)
        .min(resource_count.saturating_sub(capacity));
    (first, capacity.min(resource_count.saturating_sub(first)))
}

fn configure_field_window(
    model: &ControlCenterModel,
    area: Rect,
    field_count: usize,
) -> (usize, usize) {
    if field_count == 0 {
        return (0, 0);
    }
    let capacity = usize::from(area.height / 2).max(1);
    let selected = model
        .config
        .selected_form_row
        .min(field_count.saturating_sub(1));
    let first = selected
        .saturating_sub(capacity.saturating_sub(1) / 2)
        .min(field_count.saturating_sub(capacity));
    (first, capacity.min(field_count.saturating_sub(first)))
}

fn draw_configure_draft_bar(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let changes = model.unpublished_config_change_count();
    let issues = model
        .config
        .documents
        .iter()
        .map(|document| document.diagnostics.len())
        .sum::<usize>()
        + usize::from(model.catalog_error.is_some());
    let (state, color) = if issues > 0 {
        if changes > 0 {
            (
                format!("! {issues} draft issue{} block publication", plural(issues)),
                Color::LightRed,
            )
        } else {
            (
                format!("! {issues} configuration issue{}", plural(issues)),
                Color::LightRed,
            )
        }
    } else if changes > 0 {
        (
            format!("● {changes} unpublished change{}", plural(changes)),
            Color::Yellow,
        )
    } else {
        ("Future runs only".to_owned(), Color::LightBlue)
    };
    let compact_action = if model.legacy_migration_available {
        "t run type · l migrate"
    } else {
        "t run type"
    };
    let mut spans = vec![Span::styled(state, Style::default().fg(color))];
    if changes > 0 {
        spans.extend([
            Span::styled(" · ", Style::default().fg(Color::DarkGray)),
            Span::styled("Ctrl-P publish", Style::default().fg(Color::Cyan)),
            Span::styled(" · ", Style::default().fg(Color::DarkGray)),
            Span::styled("Ctrl-D discard all", Style::default().fg(Color::Cyan)),
        ]);
    }
    spans.push(Span::styled(
        format!(" · {compact_action}"),
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(
        Paragraph::new(Line::from(spans)).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Configuration "),
        ),
        area,
    );
}

fn draw_config_domains(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let selected = model.config.selected_domain().index();
    let items = ConfigDomain::ALL
        .iter()
        .copied()
        .enumerate()
        .map(|(index, domain)| {
            let active = index == selected;
            ListItem::new(Line::from(vec![
                Span::styled(
                    if active { "▸ " } else { "  " },
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    format!("{} ", config_domain_icon(domain)),
                    Style::default().fg(config_domain_color(domain)),
                ),
                Span::styled(
                    domain.label(),
                    Style::default().add_modifier(if active {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
                ),
            ]))
            .style(if active {
                Style::default().bg(Color::Rgb(24, 52, 64))
            } else {
                Style::default()
            })
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        List::new(items).block(panel_block(" Domains ", model.focus == Focus::ConfigTree)),
        area,
    );
}

fn draw_config_resources(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let domain = model.config.selected_domain();
    let inner_width = usize::from(area.width.saturating_sub(2));
    let compact = inner_width < 32;
    let resources = model.config.domain_resources().collect::<Vec<_>>();
    let (first, visible) = configure_resource_window(model, area, resources.len());
    let items = if resources.is_empty() {
        vec![ListItem::new(vec![
            Line::styled(
                "No resources in this domain",
                Style::default().fg(Color::DarkGray),
            ),
            Line::styled(
                config_domain_description(domain),
                Style::default().fg(Color::DarkGray),
            ),
        ])]
    } else {
        resources
            .iter()
            .enumerate()
            .skip(first)
            .take(visible)
            .map(|(index, resource)| {
                let selected = index == model.config.selected_resource;
                let (state, state_label, state_color) = config_resource_state(model, resource);
                let state_suffix = if compact || state_label.is_empty() {
                    String::new()
                } else {
                    format!("  {state_label}")
                };
                let state_width = usize::from(!state.is_empty()) * 2;
                let fixed_width = 4 + state_width + UnicodeWidthStr::width(state_suffix.as_str());
                let title = short_display_width(
                    &config_resource_display_title(domain, resource),
                    inner_width.saturating_sub(fixed_width),
                );
                let group = config_resource_group(domain, resource);
                let group = short_display_width(group, inner_width.saturating_sub(4));
                let starts_group = index == first
                    || index == 0
                    || config_resource_group(domain, resources[index - 1]) != group;
                let ends_group = index + 1 == resources.len()
                    || config_resource_group(domain, resources[index + 1]) != group;
                ListItem::new(vec![
                    Line::from(vec![
                        Span::raw("  "),
                        Span::styled(
                            if starts_group { "▾ " } else { "│ " },
                            Style::default().fg(config_domain_color(domain)),
                        ),
                        Span::styled(
                            if starts_group {
                                group.clone()
                            } else {
                                String::new()
                            },
                            Style::default()
                                .fg(Color::DarkGray)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::from({
                        let mut spans = vec![
                            Span::styled(
                                if selected { "▸ " } else { "  " },
                                Style::default().fg(Color::Cyan),
                            ),
                            Span::styled(
                                if ends_group { "└─" } else { "├─" },
                                Style::default().fg(config_domain_color(domain)),
                            ),
                        ];
                        if !state.is_empty() {
                            spans.push(Span::styled(
                                format!("{state} "),
                                Style::default().fg(state_color),
                            ));
                        }
                        spans.extend([
                            Span::styled(
                                title,
                                Style::default().add_modifier(if selected {
                                    Modifier::BOLD
                                } else {
                                    Modifier::empty()
                                }),
                            ),
                            Span::styled(state_suffix, Style::default().fg(state_color)),
                        ]);
                        spans
                    }),
                ])
                .style(if selected {
                    Style::default().bg(Color::Rgb(24, 52, 64))
                } else {
                    Style::default()
                })
            })
            .collect()
    };
    let full_title = format!(" {} Resources ", domain.label());
    let title = if UnicodeWidthStr::width(full_title.as_str()) <= inner_width {
        full_title
    } else {
        format!(" {} Resources ", compact_config_domain_label(domain))
    };
    frame.render_widget(
        List::new(items).block(panel_block(&title, model.focus == Focus::ConfigForm)),
        area,
    );
}

fn draw_config_editor(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let domain = model.config.selected_domain();
    let Some(resource) = model.config.selected_resource() else {
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(domain.label(), heading_style()),
                Line::raw(""),
                Line::styled(
                    config_domain_description(domain),
                    Style::default().fg(Color::DarkGray),
                ),
                Line::raw(""),
                Line::styled(
                    "Select a resource to edit its guided fields.",
                    Style::default().fg(Color::DarkGray),
                ),
            ])
            .block(panel_block(" Guided editor ", model.focus == Focus::Yaml))
            .wrap(Wrap { trim: false }),
            area,
        );
        return;
    };
    if model.config.linked_document_editor_active()
        || domain == ConfigDomain::Advanced
        || resource.is_raw_source()
    {
        draw_yaml(frame, model, area);
    } else {
        draw_guided_resource_editor(frame, model, resource, area);
    }
}

fn draw_guided_resource_editor(
    frame: &mut Frame<'_>,
    model: &ControlCenterModel,
    resource: &ConfigResource,
    area: Rect,
) {
    let domain = model.config.selected_domain();
    let block = panel_block(" Guided editor ", model.focus == Focus::Yaml);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let (_, state_label, state_color) = config_resource_state(model, resource);
    let inner_width = usize::from(inner.width);
    let state_suffix = if state_label.is_empty() {
        String::new()
    } else {
        format!("  {state_label}")
    };
    let title = short_display_width(
        &resource.title,
        inner_width.saturating_sub(UnicodeWidthStr::width(state_suffix.as_str())),
    );
    let mut header = vec![
        Line::from(vec![
            Span::styled(title, heading_style()),
            Span::styled(state_suffix, Style::default().fg(state_color)),
        ]),
        Line::styled(
            short_display_width(
                &format!("{} · {}", resource.kind.label(), resource.subtitle),
                inner_width,
            ),
            Style::default().fg(Color::LightBlue),
        ),
        Line::styled(
            short_display_width(config_domain_description(domain), inner_width),
            Style::default().fg(Color::DarkGray),
        ),
    ];
    if domain == ConfigDomain::Agents {
        header.extend(agent_capability_lines(model, inner_width));
    }
    header.push(Line::raw(""));
    let header_height = u16::try_from(header.len()).unwrap_or(u16::MAX);
    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(header_height), Constraint::Min(2)])
        .split(inner);
    frame.render_widget(Paragraph::new(header), sections[0]);

    let rows = &model.config.form_rows;
    if rows.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled(
                    "No guided scalar fields for this resource.",
                    Style::default().fg(Color::DarkGray),
                ),
                Line::styled(
                    "Advanced keeps every source field available.",
                    Style::default().fg(Color::DarkGray),
                ),
            ])
            .wrap(Wrap { trim: true }),
            sections[1],
        );
        return;
    }
    let (first, visible) = configure_field_window(model, sections[1], rows.len());
    let items = rows
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .map(|(index, row)| {
            let selected = index == model.config.selected_form_row;
            let (context, field) = semantic_form_parts(resource, &row.path);
            let explanation = semantic_form_explanation(resource, &row.path);
            let display_value = semantic_form_display_value(resource, &row.path, &row.value);
            let value_width = usize::from(sections[1].width)
                .saturating_sub(field.chars().count() + 9)
                .max(8);
            let mut context_line = vec![
                Span::raw("    "),
                Span::styled(
                    context,
                    Style::default().fg(
                        if resource.kind == crate::configure::ConfigResourceKind::GatePolicy {
                            Color::LightBlue
                        } else {
                            Color::DarkGray
                        },
                    ),
                ),
            ];
            if let Some(explanation) = explanation {
                context_line.push(Span::styled("  ·  ", Style::default().fg(Color::DarkGray)));
                context_line.push(Span::styled(
                    explanation,
                    Style::default().fg(Color::DarkGray),
                ));
            } else {
                context_line.push(Span::styled(
                    format!("  [{}]", humanize(&row.kind)),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            ListItem::new(vec![
                Line::from(vec![
                    Span::styled(
                        if selected { "▸ " } else { "  " },
                        Style::default().fg(Color::Cyan),
                    ),
                    Span::styled(field, Style::default().add_modifier(Modifier::BOLD)),
                    Span::raw("  "),
                    Span::styled(
                        format!(" {} ", short(&display_value, value_width.saturating_sub(2))),
                        Style::default()
                            .fg(scalar_color(&row.kind))
                            .bg(Color::Rgb(36, 42, 48)),
                    ),
                ]),
                Line::from(context_line),
            ])
            .style(if selected {
                Style::default().bg(Color::Rgb(24, 52, 64))
            } else {
                Style::default()
            })
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        List::new(items).highlight_style(Style::default().fg(Color::White)),
        sections[1],
    );
}

fn config_domain_icon(domain: ConfigDomain) -> &'static str {
    match domain {
        ConfigDomain::Project => "◆",
        ConfigDomain::RunTypes => "▶",
        ConfigDomain::Agents => "●",
        ConfigDomain::Skills => "✦",
        ConfigDomain::WorkflowsTickets => "▦",
        ConfigDomain::GraphRules => "◇",
        ConfigDomain::ActionsChecks => "⚡",
        ConfigDomain::ReportsViews => "▤",
        ConfigDomain::Advanced => "{}",
    }
}

fn config_domain_color(domain: ConfigDomain) -> Color {
    match domain {
        ConfigDomain::Project => Color::LightBlue,
        ConfigDomain::RunTypes => Color::Cyan,
        ConfigDomain::Agents => Color::LightMagenta,
        ConfigDomain::Skills => Color::LightGreen,
        ConfigDomain::WorkflowsTickets => Color::Yellow,
        ConfigDomain::GraphRules => Color::LightCyan,
        ConfigDomain::ActionsChecks => Color::LightRed,
        ConfigDomain::ReportsViews => Color::Green,
        ConfigDomain::Advanced => Color::DarkGray,
    }
}

fn config_domain_description(domain: ConfigDomain) -> &'static str {
    match domain {
        ConfigDomain::Project => "Identity, initialization, storage, Git, and global defaults.",
        ConfigDomain::RunTypes => {
            "Intake, run pipelines, planning questions, and orchestration for future runs."
        }
        ConfigDomain::Agents => {
            "Planner, Lead, worker, and reviewer personas, models, prompts, and policy."
        }
        ConfigDomain::Skills => {
            "Reusable project workflows discovered from the standard Codex skills directory."
        }
        ConfigDomain::WorkflowsTickets => {
            "Ticket definitions, per-ticket workflows, run pipelines, and lifecycle."
        }
        ConfigDomain::GraphRules => "Node and edge schemas, queries, and rules that derive work.",
        ConfigDomain::ActionsChecks => {
            "Compiler-mediated actions, validation checks, and recovery boundaries."
        }
        ConfigDomain::ReportsViews => "Generated reports, run cards, and control-center views.",
        ConfigDomain::Advanced => {
            "Raw source files, imports, extensions, and expert configuration."
        }
    }
}

fn compact_config_domain_label(domain: ConfigDomain) -> &'static str {
    match domain {
        ConfigDomain::Project => "Project",
        ConfigDomain::RunTypes => "Run Types",
        ConfigDomain::Agents => "Agents",
        ConfigDomain::Skills => "Skills",
        ConfigDomain::WorkflowsTickets => "Workflows",
        ConfigDomain::GraphRules => "Graph Rules",
        ConfigDomain::ActionsChecks => "Actions",
        ConfigDomain::ReportsViews => "Reports",
        ConfigDomain::Advanced => "Advanced",
    }
}

fn config_resource_state(
    model: &ControlCenterModel,
    resource: &ConfigResource,
) -> (&'static str, &'static str, Color) {
    let Some(primary) = model
        .config
        .documents
        .iter()
        .find(|document| document.relative_path == resource.document_path)
    else {
        return ("?", "source unavailable", Color::DarkGray);
    };
    if resource.linked_documents.iter().any(|linked| {
        !model
            .config
            .documents
            .iter()
            .any(|document| document.relative_path == linked.document_path)
    }) {
        return ("?", "instructions unavailable", Color::DarkGray);
    }
    let documents = std::iter::once(primary)
        .chain(resource.linked_locators.iter().filter_map(|linked| {
            model
                .config
                .documents
                .iter()
                .find(|document| document.relative_path == linked.document_path)
        }))
        .chain(resource.linked_documents.iter().filter_map(|linked| {
            model
                .config
                .documents
                .iter()
                .find(|document| document.relative_path == linked.document_path)
        }))
        .collect::<Vec<_>>();
    let renamed = documents.iter().any(|document| {
        model
            .config
            .pending_renames
            .values()
            .any(|target| target == &document.relative_path)
    });
    let resource_changed = primary.dirty_at(&resource.locator)
        || resource.linked_locators.iter().any(|linked| {
            model
                .config
                .documents
                .iter()
                .find(|document| document.relative_path == linked.document_path)
                .is_some_and(|document| document.dirty_at(&linked.locator))
        })
        || resource.linked_documents.iter().any(|linked| {
            model
                .config
                .documents
                .iter()
                .find(|document| document.relative_path == linked.document_path)
                .is_some_and(|document| document.dirty() || document.is_new)
        });
    if model.config_document_deleted(primary) {
        ("●", "publish or discard", Color::Yellow)
    } else if documents
        .iter()
        .any(|document| !document.diagnostics.is_empty())
    {
        ("!", "fix or discard", Color::LightRed)
    } else if resource_changed
        || documents
            .iter()
            .any(|document| model.config_document_deleted(document))
        || renamed
    {
        ("●", "publish or discard", Color::Yellow)
    } else {
        ("", "", Color::DarkGray)
    }
}

fn config_resource_display_title(domain: ConfigDomain, resource: &ConfigResource) -> String {
    if domain != ConfigDomain::Agents {
        return resource.title.clone();
    }
    let Some(lane) = agent_lane(resource) else {
        return resource.title.clone();
    };
    if resource.title.eq_ignore_ascii_case(lane) {
        resource.title.clone()
    } else {
        format!("{lane} · {}", resource.title)
    }
}

fn config_resource_group(domain: ConfigDomain, resource: &ConfigResource) -> &'static str {
    use crate::configure::ConfigResourceKind as Kind;

    match domain {
        ConfigDomain::Project => match resource.kind {
            Kind::Project | Kind::Profile => "Identity",
            Kind::CodexProjectSettings => "Codex",
            _ => "Runtime",
        },
        ConfigDomain::RunTypes => match resource.kind {
            Kind::RunTypeCatalog => "Defaults",
            _ => "Run types",
        },
        ConfigDomain::Agents => match resource.kind {
            Kind::NativeAgent => "Codex agents",
            Kind::Persona => "Koni personas",
            Kind::AgentPolicy => "Run type defaults",
            _ => "Agent resources",
        },
        ConfigDomain::Skills => "Project skills",
        ConfigDomain::WorkflowsTickets => match resource.kind {
            Kind::Pipeline => "Run pipelines",
            _ => "Ticket system",
        },
        ConfigDomain::GraphRules => match resource.kind {
            Kind::NodeType | Kind::EdgeType => "Graph schema",
            Kind::GatePolicy => "Gate policies",
            _ => "Compiler logic",
        },
        ConfigDomain::ActionsChecks => match resource.kind {
            Kind::Action => "Automation",
            _ => "Quality gates",
        },
        ConfigDomain::ReportsViews => match resource.kind {
            Kind::Report => "Outputs",
            _ => "Control center",
        },
        ConfigDomain::Advanced => "Koni & Codex sources",
    }
}

fn agent_lane(resource: &ConfigResource) -> Option<&'static str> {
    let value = format!("{} {}", resource.title, resource.subtitle).to_lowercase();
    if value.contains("review") {
        Some("Reviewer")
    } else if value.contains("planner") || value.contains("planning") {
        Some("Planner")
    } else if value.contains("lead") {
        Some("Lead")
    } else if [
        "worker",
        "implementer",
        "verifier",
        "integrator",
        "designer",
        "mapper",
        "analyst",
    ]
    .iter()
    .any(|role| value.contains(role))
    {
        Some("Workers")
    } else {
        None
    }
}

fn agent_capability_style(model: &ControlCenterModel, fields: &[&str]) -> Style {
    let active = model.config.form_rows.iter().any(|row| {
        let path = row.path.to_lowercase();
        fields.iter().any(|field| path.contains(field))
    });
    Style::default()
        .fg(if active {
            Color::Black
        } else {
            Color::DarkGray
        })
        .bg(if active {
            Color::LightMagenta
        } else {
            Color::Reset
        })
        .add_modifier(if active {
            Modifier::BOLD
        } else {
            Modifier::empty()
        })
}

fn guided_editor_header_height(
    model: &ControlCenterModel,
    domain: ConfigDomain,
    width: usize,
) -> u16 {
    let capability_rows = if domain == ConfigDomain::Agents {
        agent_capability_lines(model, width).len()
    } else {
        0
    };
    u16::try_from(4 + capability_rows).unwrap_or(u16::MAX)
}

fn agent_capability_lines(model: &ControlCenterModel, width: usize) -> Vec<Line<'static>> {
    let primary = [
        ("Instructions", &["prompt", "instructions"][..]),
        ("Model", &["model"][..]),
        ("Reasoning", &["reasoning"][..]),
    ];
    let secondary = [
        ("Permissions", &["sandbox", "approval", "network"][..]),
        ("Skills & tools", &["skills", "mcp_servers"][..]),
    ];
    let separator_width = if width <= 32 { 1 } else { 2 };
    let mut lines = pack_agent_capability_group(model, width, separator_width, &primary);
    lines.extend(pack_agent_capability_group(
        model,
        width,
        separator_width,
        &secondary,
    ));
    lines
}

fn pack_agent_capability_group(
    model: &ControlCenterModel,
    width: usize,
    separator_width: usize,
    capabilities: &[(&'static str, &[&str])],
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut spans = Vec::new();
    let mut used = 0;
    for (label, fields) in capabilities {
        let badge = format!(" {label} ");
        let badge_width = UnicodeWidthStr::width(badge.as_str());
        if !spans.is_empty() && used + separator_width + badge_width > width {
            lines.push(Line::from(std::mem::take(&mut spans)));
            used = 0;
        }
        if !spans.is_empty() {
            spans.push(Span::raw(" ".repeat(separator_width)));
            used += separator_width;
        }
        spans.push(Span::styled(badge, agent_capability_style(model, fields)));
        used += badge_width;
    }
    if !spans.is_empty() {
        lines.push(Line::from(spans));
    }
    lines
}

fn draw_yaml(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let format = model
        .config
        .selected_document()
        .and_then(|document| document.relative_path.extension())
        .and_then(|extension| extension.to_str())
        .map_or("YAML", |extension| match extension {
            "toml" => "TOML",
            "md" => "MARKDOWN",
            _ => "YAML",
        });
    let resource = model.config.selected_resource();
    let source_kind = if model.config.linked_document_editor_active() {
        "Agent instructions"
    } else {
        resource.map_or("Advanced source", |resource| match resource.kind {
            crate::configure::ConfigResourceKind::Skill => "Project skill",
            crate::configure::ConfigResourceKind::MarkdownPrompt => "Persona prompt",
            _ => "Advanced source",
        })
    };
    let resource_title = resource
        .map(|resource| resource.title.as_str())
        .unwrap_or("Configuration");
    let title = format!(" {source_kind} · {resource_title} · {format} ");
    let block = panel_block(&title, model.focus == Focus::Yaml);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let split = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(4), Constraint::Length(4)])
        .split(inner);
    if let Some(document) = model.config.selected_document() {
        let visible_height = usize::from(split[0].height.max(1));
        let visible_width = usize::from(split[0].width.saturating_sub(5).max(1));
        let first_line = document
            .cursor_line
            .saturating_sub(visible_height.saturating_sub(1));
        let first_column = document
            .cursor_column
            .saturating_sub(visible_width.saturating_sub(1));
        let text = document
            .lines()
            .iter()
            .enumerate()
            .skip(first_line)
            .take(visible_height)
            .map(|(index, line)| {
                Line::from(vec![
                    Span::styled(
                        format!("{:>4} ", index + 1),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::raw(line.chars().skip(first_column).collect::<String>()),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(text), split[0]);
        if model.focus == Focus::Yaml {
            let x = split[0]
                .x
                .saturating_add(5)
                .saturating_add(
                    document
                        .cursor_column
                        .saturating_sub(first_column)
                        .min(u16::MAX as usize) as u16,
                )
                .min(split[0].right().saturating_sub(1));
            let y = split[0]
                .y
                .saturating_add(
                    document
                        .cursor_line
                        .saturating_sub(first_line)
                        .min(u16::MAX as usize) as u16,
                )
                .min(split[0].bottom().saturating_sub(1));
            frame.set_cursor_position((x, y));
        }
        let unpublished =
            document.dirty()
                || document.is_new
                || model.config_document_deleted(document)
                || model.config.pending_renames.iter().any(|(from, to)| {
                    from == &document.relative_path || to == &document.relative_path
                });
        let has_error = !document.diagnostics.is_empty() || model.catalog_error.is_some();
        let diagnostic = if !document.diagnostics.is_empty() {
            document.diagnostics.join("\n")
        } else if let Some(error) = &model.catalog_error {
            format!("semantic validation: {error}")
        } else if unpublished {
            "syntax valid · unpublished".to_owned()
        } else {
            "syntax valid".to_owned()
        };
        let diagnostic_color = if has_error {
            Color::LightRed
        } else if unpublished {
            Color::Yellow
        } else {
            Color::DarkGray
        };
        frame.render_widget(
            Paragraph::new(diagnostic)
                .style(Style::default().fg(diagnostic_color))
                .block(
                    Block::default()
                        .borders(Borders::TOP)
                        .title(" diagnostics "),
                )
                .wrap(Wrap { trim: true }),
            split[1],
        );
    } else {
        frame.render_widget(Paragraph::new("No configuration document selected."), inner);
    }
}

fn orchestration_claims_key(model: &ControlCenterModel, key: &str) -> bool {
    let Some(run) = model.selected_run_data() else {
        return false;
    };
    if run.orchestration.is_none()
        || run
            .summary
            .as_ref()
            .is_none_or(|summary| summary.status != "active")
    {
        return false;
    }
    selected_orchestration_keybindings(model).is_some_and(|bindings| {
        bindings.iter().any(|(control, binding)| {
            (matches!(control.as_str(), "toggle" | "unchained") || control.starts_with("parallel_"))
                && binding.as_str() == Some(key)
        })
    })
}

fn focus_key_label(model: &ControlCenterModel, key: &str, panel: &str) -> String {
    if orchestration_claims_key(model, key) {
        panel.to_owned()
    } else {
        format!("{key} {panel}")
    }
}

fn draw_footer(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let panel_keys = match (model.mode, model.focus) {
        (Mode::Operate, Focus::Runs) => format!(
            "{} · Space pause/play · d delete · n new · ↑/↓ or j/k select · Enter open · Tab focus · q quit",
            focus_key_label(model, "1", "Runs")
        ),
        (Mode::Operate, Focus::Tickets) => format!(
            "{} · ↑/↓ or j/k select · ←/→ or [/] queue · a actions · Tab focus · Space pause · r refresh",
            focus_key_label(model, "2", "Tickets")
        ),
        (Mode::Operate, Focus::Graph) => format!(
            "{} · ↑/↓ or j/k/PgUp/PgDn scroll · Tab focus · c configure · r refresh",
            focus_key_label(model, "6", "Graph")
        ),
        (Mode::Operate, Focus::Agents) => format!(
            "{} · {} · ↑/↓ or j/k select · 4 chat focus · wheel over Agents · r refresh",
            focus_key_label(model, "3", "Agents"),
            if model.agent_guidance_form().is_some() {
                "Enter message"
            } else {
                "read-only history"
            }
        ),
        (Mode::Operate, Focus::Activity) => format!(
            "{} · ↑/↓ or j/k/PgUp/PgDn scroll · wheel over Activity · Tab focus · r refresh",
            focus_key_label(model, "5", "Activity")
        ),
        (Mode::Operate, Focus::Questions) => {
            "Questions · ←→/[] question · ↑↓/jk option · Enter/? answer · a auto-resolve · Tab focus · r refresh".to_owned()
        }
        (Mode::Operate, Focus::Details) if model.agent_chat_is_open() => format!(
            "{} · ↑/↓ or j/k/PgUp/PgDn scroll · Home/End · Esc overview · Tab focus · r refresh",
            focus_key_label(model, "4", "Chat")
        ),
        (Mode::Operate, Focus::Details) if model.detail_panel == crate::model::Panel::Stages => {
            format!(
                "{} · Enter control current stage · ←/→ or [/] view · ↑/↓ or j/k scroll · Tab focus · r refresh",
                focus_key_label(model, "4", "Details")
            )
        }
        (Mode::Operate, Focus::Details) => format!(
            "{} · ←/→ or [/] view · ↑/↓ or j/k scroll · a actions · Tab focus · r refresh",
            focus_key_label(model, "4", "Details")
        ),
        (Mode::Operate, _) => "Tab focus · r refresh · c configure · q quit".to_owned(),
        (Mode::Configure, Focus::Yaml)
            if model.config.linked_document_editor_active()
                || model
                    .config
                    .selected_resource()
                    .is_some_and(ConfigResource::is_raw_source) =>
        {
            "Source editor · type to edit · Esc resources · Ctrl-S save · Ctrl-P publish · Ctrl-D discard all".to_owned()
        }
        (Mode::Configure, Focus::Yaml) => {
            "Guided editor · ↑/↓ or j/k setting · Enter edit · Esc resources · Ctrl-S save · Ctrl-P publish · Ctrl-D discard all · c operate".to_owned()
        }
        (Mode::Configure, Focus::ConfigTree) => {
            "Domains · ↑/↓ or j/k select · Enter resources · Tab focus · Ctrl-P publish · Ctrl-D discard all".to_owned()
        }
        (Mode::Configure, Focus::ConfigForm)
            if model.config.selected_domain() == ConfigDomain::Advanced =>
        {
            "Resources · ↑/↓ or j/k select · Enter open · n new · m rename · d delete · Ctrl-P publish · Ctrl-D discard all".to_owned()
        }
        (Mode::Configure, Focus::ConfigForm) => {
            let create = if model.config.selected_domain() == ConfigDomain::RunTypes {
                if model.legacy_migration_available {
                    " · t new run type · l migrate Legacy"
                } else {
                    " · t new run type"
                }
            } else {
                ""
            };
            format!(
                "Resources · ↑/↓ or j/k select · Enter open{create} · Tab focus · Ctrl-P publish · Ctrl-D discard all"
            )
        }
        (Mode::Configure, _) => {
            "Tab focus · Ctrl-S save · Ctrl-P publish · Ctrl-D discard all · c operate".to_owned()
        }
    };
    let help_key = if config_source_help_uses_f1(model) {
        "F1 help"
    } else {
        "h help"
    };
    let width = usize::from(area.width);
    if model.mode == Mode::Configure {
        let focus = match model.focus {
            Focus::ConfigTree => "Domains ↑/↓ or j/k · Enter open",
            Focus::ConfigForm => "Resources ↑/↓ or j/k · Enter open",
            Focus::Yaml
                if model.config.linked_document_editor_active()
                    || model
                        .config
                        .selected_resource()
                        .is_some_and(ConfigResource::is_raw_source) =>
            {
                "Source edit · Esc back"
            }
            Focus::Yaml => "Fields ↑/↓ or j/k · Enter edit · Esc back",
            _ => "Tab focus",
        };
        let mut compact = format!(" {help_key} · Ctrl-P publish · Ctrl-D discard · {focus}");
        let used = UnicodeWidthStr::width(compact.as_str());
        if !model.status.is_empty() && used + 4 < width {
            compact.push_str(" │ ");
            compact.push_str(&short_display_width(
                &model.status,
                width.saturating_sub(used + 3),
            ));
        }
        frame.render_widget(
            Paragraph::new(short_display_width(&compact, width))
                .style(Style::default().fg(Color::Black).bg(Color::DarkGray)),
            area,
        );
        return;
    }
    let keys = format!("{help_key} · {panel_keys}");
    // Controls are the durable affordance; status is transient and may be arbitrarily long.
    // Keeping controls first makes contextual help discoverable at every supported width.
    let status = if model.status.is_empty() {
        format!(" {keys} ")
    } else {
        format!(" {keys}  │  {} ", model.status)
    };
    frame.render_widget(
        Paragraph::new(short_display_width(&status, width))
            .style(Style::default().fg(Color::Black).bg(Color::DarkGray)),
        area,
    );
}

fn config_source_help_uses_f1(model: &ControlCenterModel) -> bool {
    model.mode == Mode::Configure
        && model.focus == Focus::Yaml
        && (model.config.linked_document_editor_active()
            || model
                .config
                .selected_resource()
                .is_some_and(ConfigResource::is_raw_source))
}

fn selected_orchestration_keybindings(
    model: &ControlCenterModel,
) -> Option<&serde_json::Map<String, Value>> {
    model
        .selected_run_data()?
        .snapshot
        .get("views")?
        .as_array()?
        .iter()
        .find(|view| {
            view.get("kind").and_then(Value::as_str) == Some("controls")
                || view
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.contains("orchestration"))
        })?
        .get("options")?
        .get("keybindings")?
        .as_object()
}

fn panel_block<'a>(title: &'a str, focused: bool) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(if focused {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        })
}

/// A control hint is always attached to the bottom edge of its surface.
///
/// Keeping this as a shared primitive makes modal and panel renderers follow
/// the same placement, tone, and alignment convention.
fn control_tip(text: impl Into<String>) -> Line<'static> {
    Line::styled(
        format!(" {} ", text.into()),
        Style::default().fg(Color::DarkGray),
    )
    .alignment(Alignment::Center)
}

fn metadata_line(label: &str, value: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label}: "), Style::default().fg(Color::DarkGray)),
        Span::raw(value),
    ])
}

fn heading_style() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD)
}

fn json_cards(items: &[Value], label_fields: &[&str], fallback: &str) -> Text<'static> {
    let mut lines = Vec::new();
    for item in items {
        let label = label_fields
            .iter()
            .find_map(|field| item.get(field).and_then(Value::as_str))
            .or_else(|| {
                let definition = item.get("definition")?;
                label_fields
                    .iter()
                    .find_map(|field| definition.get(field).and_then(Value::as_str))
            })
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(fallback);
        lines.push(Line::styled(humanize(label), heading_style()));
        for field in [
            "status",
            "scope",
            "pause_scope",
            "impact",
            "persona",
            "model",
            "reasoning_effort",
        ] {
            if item.get(field).is_some() {
                lines.push(metadata_line(field, compact_value(item.get(field))));
            }
        }
        if let Some(options) = item.get("options").and_then(Value::as_array) {
            for option in options {
                lines.push(Line::raw(format!(
                    "  {} {}{}",
                    if option
                        .get("recommended")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        "★"
                    } else {
                        "·"
                    },
                    string_at(option, "label"),
                    option
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|description| format!(" — {description}"))
                        .unwrap_or_default()
                )));
            }
        }
        lines.push(Line::raw(""));
    }
    Text::from(lines)
}

fn pipeline_stage_cards(
    stages: &[Value],
    run: Option<&RunData>,
    model: &ControlCenterModel,
    width: usize,
) -> Text<'static> {
    let mut lines = Vec::new();
    for stage in stages {
        let definition = stage.get("definition").unwrap_or(stage);
        let title = definition
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("Workflow step");
        let status = stage
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        let live = definition
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|stage_id| run.is_some_and(|run| run.stage_has_live_agent(stage_id)));
        let display_status = if status == "running" && !model.orchestration_running && !live {
            "paused"
        } else {
            status
        };
        let glyph_style = if live {
            live_activity_style(model)
        } else {
            Style::default()
                .fg(status_color(display_status))
                .add_modifier(Modifier::BOLD)
        };
        let status_style = if live {
            live_activity_style(model)
        } else {
            Style::default().fg(status_color(display_status))
        };
        let status_label = if live {
            "Working".to_owned()
        } else {
            humanize(display_status)
        };
        let title_lines = wrap_full_text(title, width.saturating_sub(2).max(1));
        let title_style = Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD);
        let compact_metadata = 2 + title.chars().count() + 2 + status_label.chars().count() > width;
        for (index, title_line) in title_lines.into_iter().enumerate() {
            lines.push(Line::from(vec![
                Span::styled(
                    if index == 0 {
                        format!(
                            "{} ",
                            if live {
                                "⚙"
                            } else {
                                status_glyph(display_status)
                            }
                        )
                    } else {
                        "  ".to_owned()
                    },
                    glyph_style,
                ),
                Span::styled(title_line, title_style),
                if index == 0 && !compact_metadata {
                    Span::styled(format!("  {status_label}"), status_style)
                } else {
                    Span::raw("")
                },
            ]));
        }
        if compact_metadata {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(status_label, status_style),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    pipeline_stage_category(definition),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        } else {
            lines.push(Line::styled(
                format!("  {}", pipeline_stage_category(definition)),
                Style::default().fg(Color::DarkGray),
            ));
        }
        if let Some(reason) = stage_status_reason(stage) {
            let reason = run.map_or_else(
                || reason.to_owned(),
                |run| redact_control_record_ids(reason, run),
            );
            lines.push(Line::styled(
                format!("  {reason}"),
                Style::default().fg(if matches!(status, "blocked" | "failed") {
                    Color::LightRed
                } else {
                    Color::Yellow
                }),
            ));
        }
        lines.push(Line::raw(""));
    }
    Text::from(lines)
}

/// Project compiler pipeline kinds into concise operator-facing categories.
///
/// The durable pipeline intentionally normalizes source aliases: planning and
/// agent-dialog stages serialize as `action`, while initialization serializes
/// as `checkpoint`. Reversing that normalization in persisted records would
/// invalidate stage hashes. The control center can still recover the intended
/// human category from compiler-validated config and the already-visible stage
/// title, keeping runtime vocabulary out of the primary interface.
fn pipeline_stage_category(definition: &Value) -> &'static str {
    let kind = definition
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let config = definition.get("config").unwrap_or(&Value::Null);
    let title = definition
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "planning" | "agent_dialog" => "Planning",
        "orchestration" => "Execution",
        "agent_review" | "review" => "Review",
        "external_loop" => "External work",
        "question" | "form" => "Questions",
        "approval" => "Approval",
        "handoff" => "Handoff",
        "manual" if title_has_word(title, &["approve", "approval"]) => "Approval",
        "manual" => "Human decision",
        "initialize" => "Initialization",
        "checkpoint"
            if config.get("checkpoint").and_then(Value::as_str) == Some("verification") =>
        {
            "Verification"
        }
        "checkpoint" if title_has_word(title, &["initialize", "initialization"]) => {
            "Initialization"
        }
        "checkpoint" if title_has_word(title, &["verify", "verification"]) => "Verification",
        "checkpoint" => "Quality check",
        "action" | "profile" | "legacy_profile" | "koni"
            if matches!(
                config.get("action").and_then(Value::as_str),
                Some("planning.intake" | "intake.capture" | "intake.validate")
            ) =>
        {
            "Intake"
        }
        "action" | "profile" | "legacy_profile" | "koni"
            if config.get("action").and_then(Value::as_str) == Some("report") =>
        {
            "Report"
        }
        "action" | "profile" | "legacy_profile" | "koni"
            if config.get("persona").and_then(Value::as_str).is_some() =>
        {
            "Planning"
        }
        "action" | "profile" | "legacy_profile" | "koni"
            if title_has_word(title, &["plan", "planning"]) =>
        {
            "Planning"
        }
        "action" | "profile" | "legacy_profile" | "koni"
            if title_has_word(title, &["report", "reporting"]) =>
        {
            "Report"
        }
        "action" | "profile" | "legacy_profile" | "koni" => "Automation",
        _ => "Workflow",
    }
}

fn title_has_word(title: &str, words: &[&str]) -> bool {
    title
        .split(|character: char| !character.is_alphanumeric())
        .any(|part| words.iter().any(|word| part.eq_ignore_ascii_case(word)))
}

/// Project a durable pipeline reason into operator-facing prose.
///
/// Terminal and pause reasons deliberately retain exact compiler diagnostics on
/// disk. Those diagnostics can name control-plane records, though, and record
/// identifiers are implementation detail in the control center. Build the
/// replacement set exclusively from records in the selected run so scientific
/// labels and arbitrary prose are left alone.
fn redact_control_record_ids(message: &str, run: &RunData) -> String {
    let mut replacements = BTreeMap::<String, String>::new();
    let mut add = |source: String, replacement: String| {
        if !source.trim().is_empty() {
            replacements.entry(source).or_insert(replacement);
        }
    };

    if let Some(run_id) = run
        .summary
        .as_ref()
        .map(|summary| summary.id.trim())
        .filter(|run_id| !run_id.is_empty())
    {
        for prefix in ["run", "Run"] {
            add(format!("{prefix} {run_id}"), "this run".to_owned());
        }
        add(run_id.to_owned(), "the current run".to_owned());
    }

    // Agent phrases come first so an agent id derived from a stage id (for
    // example `orchestration-orchestrate`) wins over the shorter stage id.
    for agent in &run.agents {
        let Some(agent_id) = agent
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|agent_id| !agent_id.is_empty())
        else {
            continue;
        };
        let persona = agent
            .get("persona")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|persona| !persona.is_empty());
        if let Some(persona) = persona {
            let friendly_persona = humanize(persona);
            for label in [persona.to_owned(), friendly_persona.clone()] {
                add(format!("{label} {agent_id}"), format!("{label} agent"));
            }
            add(agent_id.to_owned(), format!("the {friendly_persona} agent"));
        } else {
            add(agent_id.to_owned(), "the agent".to_owned());
        }
        for prefix in ["agent", "Agent"] {
            add(format!("{prefix} {agent_id}"), prefix.to_owned());
        }
    }

    for stage in &run.stages {
        let definition = stage.get("definition").unwrap_or(stage);
        let Some(stage_id) = definition
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|stage_id| !stage_id.is_empty())
        else {
            continue;
        };
        let title = definition
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty());
        let (qualified, standalone) = title.map_or_else(
            || {
                (
                    "workflow stage".to_owned(),
                    "the current workflow stage".to_owned(),
                )
            },
            |title| (format!("stage “{title}”"), format!("the “{title}” stage")),
        );
        for prefix in ["stage", "Stage"] {
            add(format!("{prefix} {stage_id}"), qualified.clone());
        }
        add(stage_id.to_owned(), standalone);
    }

    for ticket in &run.tickets {
        let Some(ticket_id) = ticket
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|ticket_id| !ticket_id.is_empty())
        else {
            continue;
        };
        let title = display_ticket_title(ticket);
        let (qualified, standalone) = if title.trim().is_empty() || title == "Untitled ticket" {
            (
                "the affected work item".to_owned(),
                "the affected work item".to_owned(),
            )
        } else {
            (format!("ticket “{title}”"), format!("the “{title}” ticket"))
        };
        for prefix in ["ticket", "Ticket"] {
            add(format!("{prefix} {ticket_id}"), qualified.clone());
        }
        add(ticket_id.to_owned(), standalone);
    }

    let mut replacements = replacements.into_iter().collect::<Vec<_>>();
    replacements.sort_by_key(|(source, _)| std::cmp::Reverse(source.len()));
    replace_display_tokens(message, &replacements)
}

fn replace_display_tokens(message: &str, replacements: &[(String, String)]) -> String {
    let mut rendered = String::with_capacity(message.len());
    let mut cursor = 0;
    while cursor < message.len() {
        let replacement = replacements.iter().find(|(source, _)| {
            if !message[cursor..].starts_with(source) {
                return false;
            }
            let end = cursor + source.len();
            let starts_at_boundary = message[..cursor]
                .chars()
                .next_back()
                .is_none_or(|character| !is_ascii_identifier_character(character));
            let ends_at_boundary = message[end..]
                .chars()
                .next()
                .is_none_or(|character| !is_ascii_identifier_character(character));
            starts_at_boundary && ends_at_boundary
        });
        if let Some((source, replacement)) = replacement {
            rendered.push_str(replacement);
            cursor += source.len();
        } else {
            let character = message[cursor..]
                .chars()
                .next()
                .expect("cursor remains on a character boundary");
            rendered.push(character);
            cursor += character.len_utf8();
        }
    }
    rendered
}

fn is_ascii_identifier_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn stage_status_reason(stage: &Value) -> Option<&str> {
    stage
        .get("terminal_reason")
        .or_else(|| stage.get("pause_reason"))
        .or_else(|| stage.get("error"))
        .and_then(|reason| {
            reason
                .as_str()
                .or_else(|| reason.get("message").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|value| match value {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn compact_value(value: Option<&Value>) -> String {
    value
        .map(|value| match value {
            Value::String(value) => value.clone(),
            Value::Array(items) => items
                .iter()
                .map(|value| match value {
                    Value::String(value) => value.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(", "),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn status_glyph(status: &str) -> &'static str {
    match status {
        "passed" | "succeeded" | "skipped" | "complete" | "completed" | "concluded" | "closed"
        | "done" | "superseded" => "●",
        "active" | "running" | "in_progress" | "leased" | "review" | "integrating" => "◐",
        "planning" | "awaiting_input" | "waiting" | "paused" | "pending" | "ready" | "todo"
        | "queued" | "proposed" => "○",
        "failed" | "blocked" | "error" => "!",
        _ => "·",
    }
}

fn compact_token_count(tokens: u64) -> String {
    const UNITS: [(&str, u64); 5] = [
        ("", 1),
        ("K", 1_000),
        ("M", 1_000_000),
        ("B", 1_000_000_000),
        ("T", 1_000_000_000_000),
    ];
    let mut unit = UNITS
        .iter()
        .rposition(|(_, divisor)| tokens >= *divisor)
        .unwrap_or_default();
    if unit == 0 {
        return format!("{tokens} tks");
    }

    let mut tenths = rounded_token_tenths(tokens, UNITS[unit].1);
    if tenths >= 10_000 && unit + 1 < UNITS.len() {
        unit += 1;
        tenths = rounded_token_tenths(tokens, UNITS[unit].1);
    }
    let whole = tenths / 10;
    let fraction = tenths % 10;
    let amount = if fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    };
    format!("{amount}{} tks", UNITS[unit].0)
}

fn compact_new_token_count(tokens: u64) -> String {
    format!(
        "{} new tks",
        compact_token_count(tokens).trim_end_matches(" tks")
    )
}

fn rounded_token_tenths(tokens: u64, divisor: u64) -> u128 {
    (u128::from(tokens) * 10 + u128::from(divisor) / 2) / u128::from(divisor)
}

fn status_color(status: &str) -> Color {
    match status {
        "passed" | "succeeded" | "skipped" | "complete" | "completed" | "concluded" | "closed"
        | "done" | "superseded" => Color::Green,
        "active" | "running" | "in_progress" | "leased" | "review" | "integrating" => Color::Cyan,
        "planning" | "awaiting_input" | "waiting" | "paused" => Color::Yellow,
        "failed" | "blocked" | "error" => Color::LightRed,
        _ => Color::DarkGray,
    }
}

fn ticket_is_closed(ticket: &Value) -> bool {
    matches!(
        ticket.get("status").and_then(Value::as_str),
        Some("closed" | "complete" | "completed" | "done" | "cancelled" | "superseded")
    )
}

fn ticket_completed_successfully(ticket: &Value) -> bool {
    matches!(
        ticket.get("status").and_then(Value::as_str),
        Some("closed" | "complete" | "completed" | "done")
    )
}

fn display_ticket_title(ticket: &Value) -> String {
    let title = ticket
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Untitled ticket")
        .trim();
    let operation = ticket
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stripped = title
        .strip_prefix(operation)
        .and_then(|rest| rest.strip_prefix(':'))
        .map(str::trim)
        .filter(|rest| !rest.is_empty())
        .unwrap_or(title);
    stripped.to_owned()
}

fn humanize(value: &str) -> String {
    let normalized = value
        .trim()
        .replace(['_', '-', '.'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return "—".to_owned();
    };
    first.to_uppercase().chain(characters).collect::<String>()
}

fn value_len(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Object(items)) => items.len(),
        Some(Value::String(value)) if !value.is_empty() => 1,
        Some(Value::Null) | None => 0,
        Some(_) => 1,
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn action_label(action: &str) -> String {
    match action {
        "compile-full" => "Compile project".to_owned(),
        "compile-ticket" => "Compile selected ticket".to_owned(),
        "spawn-lead" => "Start planning lead".to_owned(),
        "spawn-worker" => "Start next worker".to_owned(),
        "context" => "Prepare agent context".to_owned(),
        "output" => "Record step output".to_owned(),
        "review" => "Review selected ticket".to_owned(),
        "finish" => "Finish selected ticket".to_owned(),
        "steer" => "Add steering guidance".to_owned(),
        "start" => "Start selected ticket".to_owned(),
        "report" => "Build run report".to_owned(),
        "recover" => "Recover runtime state".to_owned(),
        other => humanize(other),
    }
}

fn action_description(action: &str) -> &'static str {
    match action {
        "compile-full" => "Validate project state and derive eligible work.",
        "compile-ticket" => "Validate the ticket checkout and refresh its work.",
        "spawn-lead" => "Launch the configured lead persona for this run.",
        "spawn-worker" => "Launch the next compiler-selected workflow persona.",
        "context" => "Materialize the scoped context pack for the selected ticket.",
        "output" => "Attach structured results and receipts to the current step.",
        "review" => "Run the configured review gate against ticket evidence.",
        "finish" => "Integrate a reviewed ticket after lifecycle validation.",
        "steer" => "Record durable guidance for this run or selected ticket.",
        "start" => "Create or restore the isolated checkout for this ticket.",
        "report" => "Compile the configured summary for this run.",
        "recover" => "Reconcile stale workers, leases, and interrupted runtime state.",
        _ => "Run the configured compiler-mediated lifecycle action.",
    }
}

fn form_path_parts(path: &str) -> (String, String) {
    let mut parts = path
        .trim_start_matches(['$', '.', '/'])
        .split(['.', '/'])
        .filter(|segment| !segment.is_empty())
        .map(humanize_path_segment)
        .collect::<Vec<_>>();
    let field = parts.pop().unwrap_or_else(|| "Value".to_owned());
    let context = if parts.is_empty() {
        "Project settings".to_owned()
    } else {
        parts
            .into_iter()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" › ")
    };
    (context, field)
}

fn semantic_form_parts(resource: &ConfigResource, path: &str) -> (String, String) {
    if resource.kind == crate::configure::ConfigResourceKind::GatePolicy {
        return gate_policy_form_parts(path);
    }
    if resource.domain == ConfigDomain::RunTypes {
        let (context, field) = form_path_parts(path);
        if path
            .trim_start_matches(['$', '.', '/'])
            .split(['.', '/'])
            .any(|segment| segment == "questions")
        {
            return ("Planning Questions".to_owned(), field);
        }
        return (context, field);
    }
    if resource.domain != ConfigDomain::Agents {
        return form_path_parts(path);
    }
    let (_, default_field) = form_path_parts(path);
    let normalized = path.to_lowercase();
    let field = if normalized.ends_with("developer_instructions") || normalized.ends_with("prompt")
    {
        "Instructions".to_owned()
    } else if normalized.ends_with("model_reasoning_effort")
        || normalized.ends_with("reasoning_effort")
    {
        "Reasoning".to_owned()
    } else if normalized.ends_with("model_role") {
        "Run role".to_owned()
    } else if normalized.ends_with("sandbox_mode") || normalized.ends_with("sandbox.mode") {
        "Sandbox".to_owned()
    } else if normalized.ends_with("approval_policy") {
        "Approvals".to_owned()
    } else if normalized.ends_with("network_access") {
        "Network".to_owned()
    } else {
        default_field
    };
    let context = if normalized.contains("prompt") || normalized.contains("instructions") {
        "Instructions"
    } else if normalized.contains("model") || normalized.contains("reasoning") {
        "Model & reasoning"
    } else if normalized.contains("sandbox")
        || normalized.contains("approval")
        || normalized.contains("network")
        || normalized.contains("writable_roots")
    {
        "Permissions"
    } else if normalized.contains("skills") || normalized.contains("mcp_servers") {
        "Skills & tools"
    } else {
        "Identity"
    };
    (context.to_owned(), field)
}

fn gate_policy_form_parts(path: &str) -> (String, String) {
    let (_, default_field) = form_path_parts(path);
    let normalized = path.to_lowercase();
    let context = if normalized.contains("required_subject_node_types")
        || normalized.contains("subject_node_types")
        || normalized.contains("obligation_key_template")
    {
        "Required coverage"
    } else if normalized.contains("execution_ready") {
        "Execution readiness"
    } else if normalized.contains("auto_evaluate") {
        "Automatic evaluation"
    } else if normalized.contains("passing_receipt") {
        "Verification evidence"
    } else if normalized.contains("applicability") {
        "Applicability & inheritance"
    } else if normalized.contains("capability") {
        "Capability contract"
    } else if normalized.contains("candidate")
        || normalized.contains("selection")
        || normalized.contains("rank")
        || normalized.contains("tie_break")
    {
        "Provider selection"
    } else if normalized.contains("evaluation_targets") || normalized.contains("context") {
        "Evaluation context"
    } else {
        "Identity"
    };
    let field = if normalized.contains("required_subject_node_types") {
        indexed_semantic_label(path, "required_subject_node_types", "Required subject type")
    } else if normalized.contains("applicability.subject_node_types") {
        indexed_semantic_label(path, "subject_node_types", "Covered subject type")
    } else if normalized.ends_with("missing_gate_obligation_key_template") {
        "Missing-gate blocker name".to_owned()
    } else if normalized.ends_with("obligation_key_template") {
        "Gate blocker name".to_owned()
    } else if normalized.contains("auto_evaluate.boundaries") {
        indexed_semantic_label(path, "boundaries", "Evaluation boundary")
    } else if normalized.ends_with("auto_evaluate.check") {
        "Verifier check".to_owned()
    } else if normalized.contains("execution_ready") {
        execution_readiness_field_label(path, &normalized, default_field)
    } else if normalized.ends_with("mode") {
        "Selection mode".to_owned()
    } else if normalized.ends_with("tie_break.field") {
        "Tie-break field".to_owned()
    } else if normalized.ends_with("tie_break.direction") {
        "Tie-break direction".to_owned()
    } else if normalized.ends_with("cardinality") {
        "Target cardinality".to_owned()
    } else if normalized.contains("passing_receipt_statuses") {
        "Passing receipt status".to_owned()
    } else if normalized.ends_with("gate_subjects") {
        "Enabled gates".to_owned()
    } else if normalized.ends_with("candidate_pool") {
        "Provider pool".to_owned()
    } else {
        default_field
    };
    (context.to_owned(), field)
}

fn indexed_semantic_label(path: &str, marker: &str, label: &str) -> String {
    let Some((_, tail)) = path.split_once(marker) else {
        return label.to_owned();
    };
    let Some(index) = tail
        .split_once('[')
        .map(|(_, tail)| tail)
        .and_then(|tail| tail.split_once(']'))
        .and_then(|(index, _)| index.parse::<usize>().ok())
    else {
        return label.to_owned();
    };
    format!("{label} {}", index + 1)
}

fn execution_readiness_field_label(path: &str, normalized: &str, default_field: String) -> String {
    if normalized.ends_with("execution_ready") {
        return "Ready to execute".to_owned();
    }
    let ordinal = indexed_semantic_label(path, "execution_ready", "Readiness rule");
    if normalized.ends_with(".op") {
        ordinal
    } else if normalized.ends_with(".subject") {
        ordinal.replace("Readiness rule", "Rule target")
    } else if normalized.ends_with(".field") {
        ordinal.replace("Readiness rule", "Rule field")
    } else if normalized.ends_with(".value") {
        ordinal.replace("Readiness rule", "Expected value")
    } else {
        default_field
    }
}

fn semantic_form_explanation(resource: &ConfigResource, path: &str) -> Option<&'static str> {
    if resource.kind != crate::configure::ConfigResourceKind::GatePolicy {
        return None;
    }
    let normalized = path.to_lowercase();
    Some(if normalized.contains("required_subject_node_types") {
        "Every node of this type must have an applicable gate."
    } else if normalized.contains("applicability.subject_node_types") {
        "This policy knows how to evaluate this subject type."
    } else if normalized.ends_with("missing_gate_obligation_key_template") {
        "Names the blocker created when required work has no gate."
    } else if normalized.ends_with("obligation_key_template") {
        "Names the blocker held until a gate has current passing evidence."
    } else if normalized.contains("execution_ready") {
        "Must pass before Koni spends tokens running the verifier."
    } else if normalized.ends_with("auto_evaluate.check") {
        "The check Koni runs without creating an operator ticket."
    } else if normalized.contains("auto_evaluate.boundaries") {
        "A compiler moment that may trigger this check."
    } else if normalized.contains("passing_receipt_statuses") {
        "A current receipt with this result clears the gate blocker."
    } else if normalized.contains("candidate") || normalized.contains("selection") {
        "Controls which compatible provider wins deterministically."
    } else if normalized.contains("applicability") {
        "Controls direct and inherited gates for the current subject."
    } else if normalized.contains("capability") {
        "Describes the protocol a provider must satisfy."
    } else if normalized.contains("evaluation_targets") || normalized.contains("context") {
        "Defines the exact work and read context the verifier receives."
    } else {
        "Describes this policy's gate universe."
    })
}

fn semantic_form_display_value(resource: &ConfigResource, path: &str, value: &str) -> String {
    if resource.kind != crate::configure::ConfigResourceKind::GatePolicy {
        return value.to_owned();
    }
    let normalized = path.to_lowercase();
    if normalized.contains("missing_gate_obligation_key_template")
        || normalized.ends_with("obligation_key_template")
    {
        return humanize(
            &value
                .replace("{{ subject.id }}", "each subject")
                .replace("{{ gate.id }}", "each gate"),
        );
    }
    if normalized.contains("auto_evaluate.boundaries") {
        return match value {
            "full" => "Full project compile".to_owned(),
            "scoped" => "Scoped ticket compile".to_owned(),
            _ => humanize(value),
        };
    }
    if normalized.ends_with("auto_evaluate.check")
        || normalized.contains("required_subject_node_types")
        || normalized.contains("applicability.subject_node_types")
        || normalized.contains("gate_node_types")
        || normalized.contains("candidate_node_types")
        || normalized.contains("passing_receipt_statuses")
    {
        return humanize(value);
    }
    if normalized.contains("execution_ready") {
        return match value {
            "$winner" => "Selected provider".to_owned(),
            "filesystem_manifest_current" => "Files match approved manifest".to_owned(),
            "field_equals" => "Field matches expected value".to_owned(),
            "field_present" => "Field is present".to_owned(),
            _ => humanize(value),
        };
    }
    value.to_owned()
}

fn humanize_path_segment(segment: &str) -> String {
    let Some((name, index)) = segment.rsplit_once('[') else {
        return humanize(segment);
    };
    let Some(index) = index
        .strip_suffix(']')
        .and_then(|index| index.parse::<usize>().ok())
    else {
        return humanize(segment);
    };
    format!("{} {}", humanize(name), index + 1)
}

fn node_color(node_type: &str) -> Color {
    // Preserve the stable node palette from the autoresearch-v2 cockpit.
    // Relationship segments inherit their target node's color.
    match node_type {
        "hypothesis" | "run" => Color::LightMagenta,
        "claim" | "method" | "report" => Color::LightBlue,
        "experiment" | "gate" => Color::Yellow,
        "ablation" => Color::LightRed,
        "asset" | "evidence" => Color::Green,
        "metric" => Color::LightCyan,
        _ => Color::White,
    }
}

fn scalar_color(kind: &str) -> Color {
    match kind {
        "boolean" => Color::LightMagenta,
        "number" => Color::LightBlue,
        "null" => Color::DarkGray,
        _ => Color::LightGreen,
    }
}

fn short(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "…".chars().take(width).collect();
    }
    let mut output: String = value.chars().take(width - 1).collect();
    output.push('…');
    output
}

fn short_display_width(value: &str, width: usize) -> String {
    if UnicodeWidthStr::width(value) <= width {
        return value.to_owned();
    }
    if width == 0 {
        return String::new();
    }

    let ellipsis = '…';
    let ellipsis_width = UnicodeWidthChar::width(ellipsis).unwrap_or(1);
    if width <= ellipsis_width {
        return ellipsis.to_string();
    }

    let content_width = width - ellipsis_width;
    let mut used = 0;
    let mut output = String::new();
    for character in value.chars() {
        let character_width = UnicodeWidthChar::width(character).unwrap_or_default();
        if used + character_width > content_width {
            break;
        }
        output.push(character);
        used += character_width;
    }
    output.push(ellipsis);
    output
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use serde_json::json;

    use super::*;

    #[test]
    fn delete_run_objective_preview_is_capped_at_two_lines() {
        let preview = delete_run_objective_preview_lines(
            "First objective line\nSecond objective line\nThird objective line must stay hidden",
            40,
        );
        let text = preview
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert_eq!(text.len(), 2);
        assert_eq!(text[0], "First objective line");
        assert_eq!(text[1], "Second objective line…");
        assert!(!text.join("\n").contains("Third objective line"));
    }

    #[test]
    fn approval_markdown_uses_indented_lists_and_highlights_decisions() {
        let lines = approval_markdown_lines(
            "1. Choose the storage format\n   - Decision: Use notes.json\n2. Add src/store.ts",
            80,
        );
        let rendered = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert!(rendered[0].starts_with("  1. "), "{rendered:#?}");
        assert!(
            rendered
                .iter()
                .any(|line| line.starts_with("    • Decision:")),
            "{rendered:#?}"
        );
        assert!(rendered.iter().any(|line| line.starts_with("  2. ")));
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("Decision:") && span.style.fg == Some(Color::LightGreen)
            })
        }));
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("src/store.ts") && span.style.fg == Some(Color::LightBlue)
            })
        }));
    }

    #[test]
    fn approval_review_items_render_as_scan_heading_and_muted_description() {
        let lines = approval_markdown_lines(
            "### Shared storage contract\n\nKeep every SPICED field in one typed record.",
            80,
        );

        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("Shared storage contract")
                    && span.style.fg == Some(Color::Cyan)
                    && span.style.add_modifier.contains(Modifier::BOLD)
            })
        }));
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content
                    .contains("Keep every SPICED field in one typed record.")
                    && span.style.fg == Some(Color::Gray)
            })
        }));
    }

    #[test]
    fn legacy_graph_options_without_layout_keep_the_autoresearch_outline_default() {
        let values = vec![
            json!({
                "id": "h",
                "type": "hypothesis",
                "title": "Finite list sortedness",
                "edges": {"claims": ["c"]}
            }),
            json!({
                "id": "c",
                "type": "claim",
                "title": "Adjacent pairs are ordered",
                "edges": {}
            }),
        ];
        let options = json!({
            "hierarchy": ["hypothesis", "claim"],
            "show_titles": true
        });
        let text = graph_renderer_for_options(false, Some(&options))
            .render_values(&values, 72)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(text.contains("[hypothesis]"), "{text}");
        assert!(text.contains("[claim]"), "{text}");
        assert!(text.contains("<claims>"), "{text}");
        assert!(text.starts_with("[hypothesis]"), "{text}");
        assert!(text.contains('│') || text.contains('─'), "{text}");
    }

    #[test]
    fn graph_options_wire_layering_and_contextual_node_repetition() {
        let values = vec![
            json!({
                "id":"h",
                "type":"hypothesis",
                "title":"Root",
                "edges":{"claims":["c"],"gates":["g"]}
            }),
            json!({
                "id":"c",
                "type":"claim",
                "title":"Claim",
                "edges":{"gates":["g"]}
            }),
            json!({"id":"g","type":"gate","title":"Shared gate","edges":{}}),
        ];
        let options = json!({
            "layout":"layered",
            "hierarchy":["hypothesis","claim","gate"],
            "layers":[["hypothesis"],["claim"],["gate"]],
            "primary_parent_preferences":{
                "claim":["hypothesis"],
                "gate":["hypothesis","claim"]
            },
            "repeat_semantic_types":["gate"],
            "show_titles":true
        });
        let lines = graph_renderer_for_options(false, Some(&options)).render_values(&values, 72);

        assert_eq!(
            lines
                .iter()
                .flat_map(|line| &line.node_spans)
                .filter(|span| span.node_type == "gate")
                .count(),
            2,
            "{lines:#?}"
        );
    }

    #[test]
    fn ticket_graph_is_a_semantic_diff_lens_over_the_run_graph() {
        let baseline = vec![
            json!({
                "id":"root",
                "type":"claim",
                "title":"Original root",
                "edges":{"supports":["stable"]}
            }),
            json!({"id":"stable","type":"evidence","title":"Stable node","edges":{}}),
            json!({"id":"removed","type":"gate","title":"Removed node","edges":{}}),
        ];
        let projected = vec![
            json!({
                "id":"root",
                "type":"claim",
                "title":"Changed root",
                "edges":{"tests":["stable"],"adds":["new"]}
            }),
            json!({"id":"stable","type":"evidence","title":"Stable node","edges":{}}),
            json!({"id":"new","type":"experiment","title":"New node","edges":{}}),
        ];

        let diff = ticket_graph_diff(&baseline, &projected);
        assert_eq!(diff.nodes.get("root"), Some(&GraphChange::Modified));
        assert_eq!(diff.nodes.get("new"), Some(&GraphChange::Added));
        assert_eq!(diff.nodes.get("removed"), Some(&GraphChange::Deleted));
        assert!(!diff.nodes.contains_key("stable"));
        for relation in ["supports", "tests"] {
            assert_eq!(
                diff.edges.get(&GraphEdgeRef {
                    source: "root".to_owned(),
                    relation: relation.to_owned(),
                    target: "stable".to_owned(),
                }),
                Some(&GraphChange::Modified)
            );
        }
        assert_eq!(
            diff.edges.get(&GraphEdgeRef {
                source: "root".to_owned(),
                relation: "adds".to_owned(),
                target: "new".to_owned(),
            }),
            Some(&GraphChange::Added)
        );
        assert_eq!(diff.graph.len(), 4);

        let lines = GraphRenderer::new(false).render_values(&diff.graph, 80);
        assert!(lines.iter().flat_map(|line| &line.edge_spans).any(|span| {
            edge_span_change(&span.edge_refs, &diff) == Some(GraphChange::Modified)
        }));
        let styled = lines
            .iter()
            .map(|line| graph_line(line, Some(&diff)))
            .collect::<Vec<_>>();
        for (title, color) in [
            ("Changed root", Color::Yellow),
            ("New node", Color::LightGreen),
            ("Removed node", Color::LightRed),
            ("Stable node", Color::DarkGray),
        ] {
            assert!(
                styled.iter().any(|line| {
                    line.spans
                        .iter()
                        .any(|span| span.content.contains(title) && span.style.fg == Some(color))
                }),
                "missing {title:?} in {styled:#?}"
            );
        }
    }

    #[test]
    fn selected_ticket_graph_is_labeled_as_its_checkout() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active"},
                "graph":[{"id":"base","type":"task","title":"Base","edges":{}}],
                "ticket_graphs":{"ticket":{"graph":[
                    {"id":"base","type":"task","title":"Base","edges":{}},
                    {"id":"candidate","type":"task","title":"Candidate","edges":{}}
                ]}},
                "tickets":[{"id":"ticket","title":"Scoped work","status":"in_progress"}]
            }),
        );
        model.focus_tickets();
        model.focus = Focus::Graph;
        let backend = TestBackend::new(44, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                draw_graph(frame, &model, area);
            })
            .unwrap();
        let rendered = rendered_text(&terminal);

        assert!(
            rendered.contains("Graph · ticket checkout · 2 nodes"),
            "{rendered}"
        );
    }

    #[test]
    fn compact_ticket_selection_renders_a_colored_graph_diff_dashboard() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Test graph diffs","status":"active"},
                "tickets":[{
                    "id":"ticket",
                    "title":"Change the graph",
                    "status":"in_progress",
                    "operation":"implement",
                    "workflow":[],
                    "outputs":[],
                    "blockers":[]
                }],
                "graph":[
                    {"id":"root","type":"claim","title":"Original root","edges":{"supports":["stable"]}},
                    {"id":"stable","type":"evidence","title":"Stable node","edges":{}},
                    {"id":"removed","type":"gate","title":"Removed node","edges":{}}
                ],
                "ticket_graphs":{"ticket":{"graph":[
                    {"id":"root","type":"claim","title":"Changed root","edges":{"tests":["stable"],"adds":["new"]}},
                    {"id":"stable","type":"evidence","title":"Stable node","edges":{}},
                    {"id":"new","type":"experiment","title":"New node","edges":{}}
                ]}}
            }),
        );
        model.focus_tickets();
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("Checkout graph"), "{rendered}");
        for (title, color) in [
            ("Changed root", Color::Yellow),
            ("New node", Color::LightGreen),
            ("Removed node", Color::LightRed),
            ("Stab", Color::DarkGray),
        ] {
            let position = rendered_cell_position(&terminal, title)
                .unwrap_or_else(|| panic!("missing {title}: {rendered}"));
            assert_eq!(
                terminal.backend().buffer().cell(position).unwrap().fg,
                color,
                "wrong color for {title}: {rendered}"
            );
        }
    }

    #[test]
    fn objective_collapses_to_four_lines_and_expands_without_truncation() {
        let objective = "one\ntwo\nthree\nfour\nfive\nsix\nseven";
        let collapsed = objective_preview_lines(objective, 40, Some(4));
        assert_eq!(collapsed.len(), 4);
        assert!(collapsed[3].spans[0].content.ends_with('…'));

        let expanded = objective_preview_lines(objective, 40, None);
        assert_eq!(expanded.len(), 7);
        assert!(!expanded[6].spans[0].content.ends_with('…'));
    }

    fn run_type(
        id: &str,
        title: &str,
        description: &str,
        planning_passes: usize,
        question_policy: &str,
        max_parallel: usize,
    ) -> RunTypeOption {
        let mut stages = vec![crate::model::RunStageOption {
            id: "intake".to_owned(),
            title: "Validate intake".to_owned(),
            kind: "action".to_owned(),
        }];
        stages.extend(
            (0..planning_passes).map(|index| crate::model::RunStageOption {
                id: format!("plan-{index}"),
                title: format!("Plan pass {}", index + 1),
                kind: "planning".to_owned(),
            }),
        );
        stages.extend([
            crate::model::RunStageOption {
                id: "approval".to_owned(),
                title: "Approve plan".to_owned(),
                kind: "approval".to_owned(),
            },
            crate::model::RunStageOption {
                id: "orchestrate".to_owned(),
                title: "Execute work".to_owned(),
                kind: "orchestration".to_owned(),
            },
            crate::model::RunStageOption {
                id: "report".to_owned(),
                title: "Compile report".to_owned(),
                kind: "action".to_owned(),
            },
        ]);
        let agents = ["planner", "lead", "ticket_worker", "reviewer"]
            .into_iter()
            .map(|role| {
                (
                    role.to_owned(),
                    crate::model::RunAgentSetting {
                        model: Some(if role == "ticket_worker" {
                            "gpt-5.6-terra".to_owned()
                        } else {
                            "gpt-5.6-sol".to_owned()
                        }),
                        reasoning_effort: Some("xhigh".to_owned()),
                    },
                )
            })
            .collect();
        RunTypeOption {
            id: id.to_owned(),
            title: title.to_owned(),
            description: description.to_owned(),
            planning_passes,
            question_policy: question_policy.to_owned(),
            max_parallel: Some(max_parallel),
            model_summary: Some(
                "Planner + Lead: gpt-5.6-sol/xhigh · Worker: gpt-5.6-terra/high".to_owned(),
            ),
            stages,
            agents,
        }
    }

    fn wizard_template(internal_id: &str, label: &str) -> crate::model::RunTypeTemplateDraft {
        let yaml = format!(
            r#"
schema_version: "1.0"
id: {internal_id}
title: Hidden template title
profile:
  source: .codex/koni/profile.yaml
intake:
  fields: {{}}
  order: []
pipeline:
  stages: {{}}
  order: []
questions:
  policy: interactive
  default_scope: ticket
git:
  branch_template: koni/runs/{{{{ run.id }}}}
  ticket_branch_template: koni/runs/{{{{ run.id }}}}/tickets/{{{{ ticket.id }}}}
run_card:
  sections: []
"#
        );
        crate::model::RunTypeTemplateDraft {
            label: label.to_owned(),
            description: format!("{label} workflow template."),
            document: serde_yaml::from_str(&yaml).unwrap(),
        }
    }

    fn rendered_text(terminal: &Terminal<TestBackend>) -> String {
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    fn config_document(relative: &str, text: &str) -> crate::model::ConfigDocument {
        crate::model::ConfigDocument {
            relative_path: relative.into(),
            source_path: format!("/tmp/project/.codex/koni/{relative}").into(),
            draft_path: format!("/tmp/project/.git/koni/config-drafts/{relative}").into(),
            original: text.to_owned(),
            text: text.to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        }
    }

    fn rendered_cell_position(
        terminal: &Terminal<TestBackend>,
        needle: &str,
    ) -> Option<(u16, u16)> {
        let buffer = terminal.backend().buffer();
        let width = usize::from(buffer.area.width);
        let needle = needle
            .chars()
            .map(|character| character.to_string())
            .collect::<Vec<_>>();
        (0..usize::from(buffer.area.height)).find_map(|y| {
            let row = &buffer.content()[y * width..(y + 1) * width];
            row.windows(needle.len())
                .position(|cells| {
                    cells
                        .iter()
                        .zip(&needle)
                        .all(|(cell, character)| cell.symbol() == character)
                })
                .map(|x| {
                    (
                        u16::try_from(x).unwrap_or(u16::MAX),
                        u16::try_from(y).unwrap_or(u16::MAX),
                    )
                })
        })
    }

    fn rendered_row(terminal: &Terminal<TestBackend>, row: u16) -> String {
        let buffer = terminal.backend().buffer();
        let width = usize::from(buffer.area.width);
        let start = usize::from(row) * width;
        buffer.content()[start..start + width]
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn new_run_shows_all_run_types_and_selected_metadata_without_ids() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![
            run_type(
                "internal-small-key",
                "Small",
                "A focused change with minimal coordination.",
                0,
                "autonomous",
                1,
            ),
            run_type(
                "internal-medium-key",
                "Medium",
                "A coordinated feature with explicit planning.",
                1,
                "high_impact_only",
                3,
            ),
            run_type(
                "internal-large-key",
                "Large",
                "A broad change with independent review.",
                3,
                "interactive",
                5,
            ),
        ];
        let selected = model.run_types[1].clone();
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "internal-medium-key".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: selected.max_parallel.unwrap(),
            agent_roles: selected.agents,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(120, 34);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        for title in ["Small", "Medium", "Large"] {
            assert!(rendered.contains(title), "missing {title}: {rendered}");
        }
        assert!(!rendered.contains("A coordinated feature with explicit planning."));
        assert!(rendered.contains("Objective"), "{rendered}");
        assert!(rendered.contains("Run Config"), "{rendered}");
        assert!(rendered.contains("Questions"), "{rendered}");
        assert!(!rendered.contains("Planning Questions"), "{rendered}");
        for choice in ["no", "some", "many"] {
            assert!(rendered.contains(choice), "missing {choice}: {rendered}");
        }
        assert!(rendered.contains("Max parallel agents"), "{rendered}");
        assert!(rendered.contains("Planner"), "{rendered}");
        assert!(rendered.contains("gpt-5.6-sol"), "{rendered}");
        assert!(rendered.contains("Reasoning"), "{rendered}");
        assert!(rendered.contains("xhigh"), "{rendered}");
        assert_eq!(rendered.matches("Model").count(), 1, "{rendered}");
        assert_eq!(rendered.matches("Reasoning").count(), 1, "{rendered}");
        for header in [
            "Objective",
            "Run Config",
            "Run type",
            "Stages",
            "Questions",
            "Agent",
            "Model",
            "Reasoning",
        ] {
            let position = rendered_cell_position(&terminal, header)
                .unwrap_or_else(|| panic!("missing {header}: {rendered}"));
            assert_eq!(
                terminal.backend().buffer().cell(position).unwrap().fg,
                Color::White,
                "{header} should use the shared white heading style"
            );
        }
        assert!(rendered.contains("Start Planning"), "{rendered}");
        assert!(!rendered.contains("guided intake"), "{rendered}");
        assert!(!rendered.contains("What should Koni build?"), "{rendered}");
        assert!(!rendered.contains("Workflow"), "{rendered}");
        assert!(!rendered.contains("default ·"), "{rendered}");
        assert!(!rendered.contains("override"), "{rendered}");
        for id in [
            "internal-small-key",
            "internal-medium-key",
            "internal-large-key",
        ] {
            assert!(!rendered.contains(id), "leaked {id}: {rendered}");
        }
    }

    #[test]
    fn new_run_objective_wraps_long_text_and_preserves_explicit_lines() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![run_type("medium", "Medium", "", 1, "high_impact_only", 3)];
        let goal = "WRAP-START This objective has enough prose to cross the editor width while preserving every word and then WRAP-CONTINUATION\nEXPLICIT-SECOND-LINE";
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium".to_owned(),
            goal: goal.to_owned(),
            objective_cursor: goal.chars().count(),
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(100, 38);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        let start = rendered_cell_position(&terminal, "WRAP-START")
            .unwrap_or_else(|| panic!("missing wrapped objective start: {rendered}"));
        let continuation = rendered_cell_position(&terminal, "WRAP-CONTINUATION")
            .unwrap_or_else(|| panic!("missing wrapped continuation: {rendered}"));
        let explicit = rendered_cell_position(&terminal, "EXPLICIT-SECOND-LINE")
            .unwrap_or_else(|| panic!("missing explicit objective line: {rendered}"));

        assert!(
            start.1 < continuation.1,
            "long objective did not wrap: {rendered}"
        );
        assert!(
            continuation.1 < explicit.1,
            "explicit newline did not create a new row: {rendered}"
        );
        assert!(
            rendered.contains('▏'),
            "active caret is missing: {rendered}"
        );
        assert!(
            !rendered.contains("WRAP-CONTINU…"),
            "objective was cropped: {rendered}"
        );
    }

    #[test]
    fn new_run_objective_viewport_follows_the_active_caret() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![run_type("small", "Small", "", 0, "autonomous", 1)];
        let goal = (1..=8)
            .map(|line| format!("objective-line-{line:02}"))
            .collect::<Vec<_>>()
            .join("\n");
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "small".to_owned(),
            goal: goal.clone(),
            objective_cursor: goal.chars().count(),
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(100, 38);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered_at_end = rendered_text(&terminal);
        assert!(
            rendered_at_end.contains("objective-line-08"),
            "{rendered_at_end}"
        );
        assert!(
            !rendered_at_end.contains("objective-line-01"),
            "{rendered_at_end}"
        );
        assert!(rendered_at_end.contains('▏'), "{rendered_at_end}");

        let Some(Dialog::NewRun(draft)) = model.dialog.as_mut() else {
            unreachable!();
        };
        draft.objective_cursor = 0;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered_at_start = rendered_text(&terminal);
        assert!(
            rendered_at_start.contains("objective-line-01"),
            "{rendered_at_start}"
        );
        assert!(
            !rendered_at_start.contains("objective-line-08"),
            "{rendered_at_start}"
        );
        assert!(rendered_at_start.contains('▏'), "{rendered_at_start}");
    }

    #[test]
    fn roomy_new_run_separates_each_run_config_section_with_visual_space() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let selected = run_type("medium", "Medium", "", 1, "high_impact_only", 3);
        let agents = selected.agents.clone();
        model.run_types = vec![selected];
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: 3,
            agent_roles: agents,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(120, 40);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let Dialog::NewRun(draft) = model.dialog.as_ref().unwrap() else {
            unreachable!();
        };
        let area = new_run_dialog_area(Rect::new(0, 0, 120, 40), draft, &model.run_types);
        let row_containing = |needle: &str| {
            (area.y..area.bottom())
                .find(|row| {
                    (area.x..area.right())
                        .filter_map(|column| terminal.backend().buffer().cell((column, *row)))
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains(needle)
                })
                .unwrap_or_else(|| panic!("missing {needle}"))
        };
        let run_type = row_containing("Run type");
        let run_type_option = row_containing("Medium");
        let stages = row_containing("Stages");
        let last_stage = row_containing("Compile report");
        let questions = row_containing("Questions");
        let question_chips = row_containing("some");
        let parallel = row_containing("Max parallel agents");
        let agents = row_containing("Agent");
        let reviewer = row_containing("Reviewer");
        let start = row_containing("Start Planning");

        assert_eq!(run_type_option, run_type);
        assert!(
            stages >= run_type + 2,
            "run_type={run_type}, stages={stages}, area={area:?}"
        );
        assert!(questions >= last_stage + 2);
        assert_eq!(question_chips, questions);
        assert!(parallel >= question_chips + 2);
        assert!(agents >= parallel + 2);
        assert_eq!(start, reviewer + 2);
        let separator = (area.x + 1..area.right() - 1)
            .filter_map(|column| terminal.backend().buffer().cell((column, start - 1)))
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(separator.chars().all(|character| character == '─'));
    }

    #[test]
    fn compact_new_run_shows_enabled_and_skipped_workflow_with_friendly_controls() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![
            run_type(
                "internal-small-key",
                "Small",
                "Focused work",
                0,
                "autonomous",
                1,
            ),
            run_type(
                "internal-large-key",
                "Large",
                "Broad work",
                3,
                "interactive",
                5,
            ),
        ];
        let selected = model.run_types[0].clone();
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: selected.id.clone(),
            question_policy: selected.question_policy,
            max_parallel: selected.max_parallel.unwrap(),
            agent_roles: selected.agents,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(82, 30);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("● Validate intake"), "{rendered}");
        assert!(rendered.contains("○ Plan pass 1  skipped"), "{rendered}");
        assert!(rendered.contains("● Approve plan"), "{rendered}");
        assert!(rendered.contains("Questions"), "{rendered}");
        assert!(!rendered.contains("Planning Questions"), "{rendered}");
        for choice in ["no", "some", "many"] {
            assert!(rendered.contains(choice), "missing {choice}: {rendered}");
        }
        assert!(rendered.contains("Max parallel agents"), "{rendered}");
        assert!(rendered.contains("Planner"), "{rendered}");
        assert!(rendered.contains("Start Work"), "{rendered}");
        assert!(!rendered.contains("autonomous"), "{rendered}");
        assert!(!rendered.contains("internal-small-key"), "{rendered}");
        assert!(!rendered.contains("internal-large-key"), "{rendered}");
    }

    #[test]
    fn canonical_workflow_merge_keeps_alternate_plans_before_shared_approval() {
        let stage = |id: &str, title: &str| crate::model::RunStageOption {
            id: id.to_owned(),
            title: title.to_owned(),
            kind: "action".to_owned(),
        };
        let mut large = run_type("large", "Large", "", 0, "interactive", 5);
        large.stages = vec![
            stage("intake", "Validate intake"),
            stage("architecture-plan", "Plan architecture"),
            stage("approval", "Approve plans"),
            stage("report", "Compile report"),
        ];
        let mut medium = run_type("medium", "Medium", "", 0, "interactive", 3);
        medium.stages = vec![
            stage("intake", "Validate intake"),
            stage("combined-plan", "Plan implementation"),
            stage("approval", "Approve plan"),
            stage("report", "Compile report"),
        ];

        let ids = canonical_workflow_stages(&[large, medium])
            .into_iter()
            .map(|stage| stage.id)
            .collect::<Vec<_>>();
        let position = |id: &str| ids.iter().position(|stage| stage == id).unwrap();

        assert!(position("architecture-plan") < position("approval"));
        assert!(position("combined-plan") < position("approval"));
        assert!(position("approval") < position("report"));
    }

    #[test]
    fn new_run_stages_use_full_selected_titles_and_mark_skipped_stages() {
        let stage = |id: &str, title: &str| crate::model::RunStageOption {
            id: id.to_owned(),
            title: title.to_owned(),
            kind: "action".to_owned(),
        };
        let mut large = run_type("large-internal", "Large", "", 1, "interactive", 5);
        large.stages = vec![
            stage("intake", "Validate all project intake and constraints"),
            stage("architecture", "Design the complete system architecture"),
            stage("approval", "Approve the plans after architectural review"),
            stage("report", "Compile the final implementation report"),
        ];
        let mut medium = run_type("medium-internal", "Medium", "", 1, "high_impact_only", 3);
        medium.stages = vec![
            stage("intake", "Validate the feature intake and constraints"),
            stage("implementation", "Plan the complete feature implementation"),
            stage("approval", "Approve the plan after feature review"),
            stage("report", "Compile the final feature report"),
        ];
        let selected_agents = medium.agents.clone();
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![large, medium];
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium-internal".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: 3,
            agent_roles: selected_agents,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(120, 34);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(
            rendered.contains("Validate the feature intake and constraints"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Plan the complete feature implementation"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Design the complete system architecture  skipped"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Approve the plan after feature review"),
            "{rendered}"
        );
        assert!(
            !rendered.contains("Approve the plans after architectural review"),
            "selected workflow title was not authoritative: {rendered}"
        );
        assert!(
            !rendered.contains('…'),
            "stage titles were shortened: {rendered}"
        );
        assert!(!rendered.contains("medium-internal"), "{rendered}");
        assert!(!rendered.contains("large-internal"), "{rendered}");
    }

    #[test]
    fn constrained_new_run_pages_to_every_configured_stage_without_hiding_controls() {
        let mut option = run_type("medium-internal", "Medium", "", 1, "high_impact_only", 3);
        option.stages = (1..=10)
            .map(|number| crate::model::RunStageOption {
                id: format!("stage-{number:02}"),
                title: if number == 10 {
                    "Pipeline boundary 10 deliberately wraps across several rows and ends with FINAL-STAGE-TAIL"
                        .to_owned()
                } else {
                    format!("Pipeline boundary {number:02}")
                },
                kind: "action".to_owned(),
            })
            .collect();
        let agents = option.agents.clone();
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![option];
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium-internal".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: 3,
            agent_roles: agents,
            active_field: 1,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let first_page = rendered_text(&terminal);
        assert!(first_page.contains("Stages · 1–"), "{first_page}");
        assert!(first_page.contains("of 10 · PgUp/PgDn"), "{first_page}");
        assert!(first_page.contains("Pipeline boundary 01"), "{first_page}");
        assert!(!first_page.contains("Pipeline boundary 10"), "{first_page}");
        assert!(first_page.contains("Start Planning"), "{first_page}");
        assert!(
            first_page.contains("Enter activates control"),
            "{first_page}"
        );

        let Some(Dialog::NewRun(draft)) = model.dialog.as_mut() else {
            unreachable!();
        };
        draft.stage_scroll =
            new_run_stage_line_count(&model.run_types, "medium-internal").saturating_sub(1);
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let last_page = rendered_text(&terminal);
        assert!(last_page.contains("Stages · 10–10 of 10"), "{last_page}");
        assert!(last_page.contains("FINAL-STAGE-TAIL"), "{last_page}");
        assert!(!last_page.contains("Pipeline boundary 01"), "{last_page}");
        assert!(last_page.contains("Questions"), "{last_page}");
        assert!(last_page.contains("Start Planning"), "{last_page}");
        assert!(last_page.contains("Enter activates control"), "{last_page}");
    }

    #[test]
    fn new_run_agent_model_and_reasoning_are_separate_filled_click_targets() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let mut option = run_type("medium", "Medium", "", 1, "interactive", 3);
        let planner = option.agents.get_mut("planner").unwrap();
        planner.model = Some("planner-model-v1".to_owned());
        planner.reasoning_effort = Some("deep".to_owned());
        let agents = option.agents.clone();
        model.run_types = vec![option];
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium".to_owned(),
            question_policy: "interactive".to_owned(),
            max_parallel: 3,
            agent_roles: agents,
            active_field: 4,
            ..NewRunDraft::default()
        }));
        let size = ratatui::layout::Size::new(120, 34);
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let model_position = rendered_cell_position(&terminal, "planner-model-v1").unwrap();
        let reasoning_position = rendered_cell_position(&terminal, "deep").unwrap();

        assert_eq!(
            new_run_hit_at(&model, model_position.0, model_position.1, size),
            Some(NewRunHit::Field(5))
        );
        assert_eq!(
            new_run_hit_at(&model, reasoning_position.0, reasoning_position.1, size),
            Some(NewRunHit::Field(6))
        );
        assert_eq!(
            terminal.backend().buffer().cell(model_position).unwrap().bg,
            stable_model_color("planner-model-v1")
        );
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(reasoning_position)
                .unwrap()
                .bg,
            stable_reasoning_color("deep")
        );
    }

    #[test]
    fn current_codex_models_and_reasoning_levels_have_distinct_stable_colors() {
        let models = [
            "gpt-5.5",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
        ];
        for (index, model) in models.iter().enumerate() {
            for other in models.iter().skip(index + 1) {
                assert_ne!(
                    stable_model_color(model),
                    stable_model_color(other),
                    "{model} and {other} must retain different identity colors"
                );
            }
        }
        let efforts = [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ];
        for (index, effort) in efforts.iter().enumerate() {
            for other in efforts.iter().skip(index + 1) {
                assert_ne!(
                    stable_reasoning_color(effort),
                    stable_reasoning_color(other),
                    "{effort} and {other} must retain different semantic colors"
                );
            }
        }
        let reasoning_colors = efforts
            .iter()
            .map(|effort| stable_reasoning_color(effort))
            .collect::<Vec<_>>();
        for color in &reasoning_colors {
            let Color::Rgb(red, green, blue) = color else {
                panic!("reasoning color is not a pink-axis RGB value: {color:?}");
            };
            assert!(red > blue && blue > green, "not pink-axis: {color:?}");
        }
        let saturation = |color: Color| match color {
            Color::Rgb(red, green, _) => red.saturating_sub(green),
            _ => 0,
        };
        assert!(
            reasoning_colors
                .windows(2)
                .all(|pair| saturation(pair[1]) > saturation(pair[0])),
            "reasoning saturation should rise with effort: {reasoning_colors:?}"
        );
        for model in models {
            assert!(
                !matches!(
                    stable_model_color(model),
                    Color::Red | Color::LightRed | Color::Green | Color::LightGreen
                ),
                "categorical model color should not imply success or failure: {model}"
            );
        }
    }

    #[test]
    fn question_chips_show_all_policies_and_map_clicks_to_semantic_values() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let option = run_type("medium", "Medium", "", 1, "high_impact_only", 3);
        let agents = option.agents.clone();
        model.run_types = vec![option];
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: 3,
            agent_roles: agents,
            ..NewRunDraft::default()
        }));
        let size = ratatui::layout::Size::new(120, 34);
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        for (policy, label, selected_color) in QUESTION_POLICIES {
            assert!(
                !matches!(
                    selected_color,
                    Color::Red | Color::LightRed | Color::Green | Color::LightGreen
                ),
                "question policy color should be neutral: {label}"
            );
            let expected_hit = NewRunHit::QuestionPolicy(policy.to_owned());
            let position = (0..size.height)
                .find_map(|row| {
                    (0..size.width)
                        .find(|column| {
                            new_run_hit_at(&model, *column, row, size) == Some(expected_hit.clone())
                        })
                        .map(|column| (column, row))
                })
                .unwrap_or_else(|| panic!("missing clickable {label} question chip"));
            let expected = if policy == "high_impact_only" {
                selected_color
            } else {
                Color::Rgb(32, 36, 40)
            };
            assert_eq!(
                terminal.backend().buffer().cell(position).unwrap().bg,
                expected
            );
            if policy != "high_impact_only" {
                assert_eq!(
                    terminal.backend().buffer().cell(position).unwrap().fg,
                    selected_color,
                    "inactive {label} should retain its fixed identity color"
                );
            }
        }
    }

    #[test]
    fn run_type_chips_wrap_without_hiding_options() {
        let options = vec![
            run_type("one", "Small", "", 0, "autonomous", 1),
            run_type("two", "Medium", "", 1, "high_impact_only", 3),
            run_type("three", "Large", "", 3, "interactive", 5),
        ];

        let chips = run_type_chip_layout(&options, 20);

        assert_eq!(chips.len(), 3);
        assert!(chips.iter().any(|chip| chip.row > 0));
        assert!(chips.windows(2).all(|chips| chips[1].row >= chips[0].row));
        assert_eq!(
            chips.iter().map(|chip| chip.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn constrained_new_run_pages_every_long_custom_type_into_view_and_click_range() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = (1..=18)
            .map(|number| {
                run_type(
                    &format!("internal-custom-{number:02}"),
                    &format!("Custom workflow {number:02} with a deliberately long title"),
                    "",
                    1,
                    "high_impact_only",
                    3,
                )
            })
            .collect();
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: model.run_types[0].id.clone(),
            question_policy: "high_impact_only".to_owned(),
            ..NewRunDraft::default()
        }));
        let size = ratatui::layout::Size::new(82, 20);
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let first_render = rendered_text(&terminal);
        assert!(first_render.contains("showing 1–"), "{first_render}");
        assert!(first_render.contains("of 18"), "{first_render}");
        assert!(
            first_render.contains("Custom workflow 01"),
            "{first_render}"
        );
        assert!(
            !first_render.contains("Custom workflow 18"),
            "{first_render}"
        );

        for selected in 0..model.run_types.len() {
            let expected = model.run_types[selected].id.clone();
            let Some(Dialog::NewRun(draft)) = model.dialog.as_mut() else {
                panic!("new-run dialog disappeared");
            };
            draft.run_type.clone_from(&expected);
            let hits = (0..size.height)
                .flat_map(|row| {
                    (0..size.width)
                        .filter_map(|column| new_run_type_at(&model, column, row, size))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            assert!(
                hits.contains(&expected),
                "selected type {selected} was not visible and clickable"
            );
        }

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let last_render = rendered_text(&terminal);
        assert!(last_render.contains("of 18"), "{last_render}");
        assert!(last_render.contains("Custom workflow 18"), "{last_render}");
        assert!(!last_render.contains("Custom workflow 01"), "{last_render}");
        assert!(last_render.contains("Home/End"), "{last_render}");
    }

    #[test]
    fn constrained_new_run_keeps_the_active_lower_intake_field_and_footer_visible() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.run_types = vec![
            run_type("small", "Small", "", 0, "autonomous", 1),
            run_type("medium", "Medium", "", 1, "high_impact_only", 3),
            run_type("large", "Large", "", 3, "interactive", 5),
        ];
        let intake_fields = (1..=12)
            .map(|number| crate::model::IntakeFieldDraft {
                id: format!("constraint-{number:02}"),
                label: format!("Constraint {number:02}"),
                description: format!("Guidance for constraint {number:02}"),
                field_type: "text".to_owned(),
                required: true,
                value: format!("Configured value {number:02}"),
                options: Vec::new(),
            })
            .collect::<Vec<_>>();
        model.dialog = Some(Dialog::NewRun(NewRunDraft {
            run_type: "medium".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            active_field: intake_fields.len(),
            intake_fields,
            ..NewRunDraft::default()
        }));
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        for title in ["Small", "Medium", "Large"] {
            assert!(rendered.contains(title), "missing {title}: {rendered}");
        }
        assert!(rendered.contains("Objective"), "{rendered}");
        assert!(rendered.contains("Run Config"), "{rendered}");
        assert!(rendered.contains("Constraint 12 *"), "{rendered}");
        assert!(rendered.contains("Configured value 12"), "{rendered}");
        assert!(!rendered.contains("Constraint 01"), "{rendered}");
        assert!(rendered.contains("Start Planning"), "{rendered}");
        assert!(rendered.contains("Enter activates control"), "{rendered}");
    }

    #[test]
    fn guided_run_type_templates_are_visible_clickable_and_do_not_leak_internal_ids() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let templates = [
            ("internal-small-template", "Small"),
            ("internal-medium-template", "Medium"),
            ("internal-large-template", "Large"),
            ("internal-blank-template", "Blank"),
        ]
        .map(|(id, label)| wizard_template(id, label))
        .to_vec();
        model.mode = Mode::Configure;
        model.dialog = Some(Dialog::RunTypeWizard(crate::model::RunTypeWizardDraft {
            templates,
            selected_template: 1,
            title: "UI Feature".to_owned(),
            slug: "ui-feature".to_owned(),
            description: "Interface-focused workflow".to_owned(),
            make_default: true,
            active_field: 0,
            slug_manually_edited: false,
        }));
        let size = ratatui::layout::Size::new(120, 34);
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        for label in ["Small", "Medium", "Large", "Blank"] {
            assert!(rendered.contains(label), "missing {label}: {rendered}");
        }
        for id in [
            "internal-small-template",
            "internal-medium-template",
            "internal-large-template",
            "internal-blank-template",
        ] {
            assert!(!rendered.contains(id), "leaked {id}: {rendered}");
        }
        assert!(rendered.contains("Title"));
        assert!(rendered.contains("Slug"));
        assert!(rendered.contains("Make this the default run type"));
        assert!(
            rendered.contains("standalone draft for review and later publication"),
            "{rendered}"
        );
        assert!(rendered.contains("Enter next"), "{rendered}");
        assert!(!rendered.contains("showing 1–"), "{rendered}");

        let hits = (0..size.height)
            .flat_map(|row| {
                (0..size.width)
                    .filter_map(|column| run_type_wizard_hit_at(&model, column, row, size))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        for index in 0..4 {
            assert!(hits.contains(&RunTypeWizardHit::Template(index)));
        }
        for field in 1..=4 {
            assert!(hits.contains(&RunTypeWizardHit::Field(field)));
        }
        assert!(hits.contains(&RunTypeWizardHit::Create));
    }

    #[test]
    fn constrained_wizard_pages_every_long_template_into_view_and_click_range() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let templates = (1..=18)
            .map(|number| {
                wizard_template(
                    &format!("internal-template-{number:02}"),
                    &format!("Template {number:02} with a deliberately long workflow name"),
                )
            })
            .collect();
        model.mode = Mode::Configure;
        model.dialog = Some(Dialog::RunTypeWizard(crate::model::RunTypeWizardDraft {
            templates,
            selected_template: 0,
            title: "Custom workflow".to_owned(),
            slug: "custom-workflow".to_owned(),
            description: String::new(),
            make_default: false,
            active_field: 0,
            slug_manually_edited: false,
        }));
        let size = ratatui::layout::Size::new(82, 20);
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let first_render = rendered_text(&terminal);
        assert!(first_render.contains("showing 1–"), "{first_render}");
        assert!(first_render.contains("of 18"), "{first_render}");
        assert!(first_render.contains("Template 01"), "{first_render}");
        assert!(!first_render.contains("Template 18"), "{first_render}");

        for selected in 0..18 {
            let Some(Dialog::RunTypeWizard(draft)) = model.dialog.as_mut() else {
                panic!("run-type wizard disappeared");
            };
            draft.selected_template = selected;
            let hits = (0..size.height)
                .flat_map(|row| {
                    (0..size.width)
                        .filter_map(|column| run_type_wizard_hit_at(&model, column, row, size))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            assert!(
                hits.contains(&RunTypeWizardHit::Template(selected)),
                "selected template {selected} was not visible and clickable"
            );
            assert!(hits.contains(&RunTypeWizardHit::Create));
        }

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let last_render = rendered_text(&terminal);
        assert!(last_render.contains("of 18"), "{last_render}");
        assert!(last_render.contains("Template 18"), "{last_render}");
        assert!(!last_render.contains("Template 01"), "{last_render}");
        assert!(last_render.contains("Home/End"), "{last_render}");
    }

    #[test]
    fn configure_mode_uses_short_run_type_and_legacy_migration_tips() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.focus = Focus::ConfigTree;
        model.legacy_migration_available = true;
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("t run type"), "{rendered}");
        assert!(rendered.contains("l migrate"), "{rendered}");
        assert!(!rendered.contains("t New run type"), "{rendered}");
        assert!(!rendered.contains("l Migrate Legacy"), "{rendered}");
    }

    #[test]
    fn token_counts_use_compact_run_row_abbreviations() {
        for (tokens, expected) in [
            (0, "0 tks"),
            (999, "999 tks"),
            (1_000, "1K tks"),
            (1_050_000, "1.1M tks"),
            (999_999, "1M tks"),
            (2_450_000_000, "2.5B tks"),
        ] {
            assert_eq!(compact_token_count(tokens), expected);
        }
        assert_eq!(compact_new_token_count(0), "0 new tks");
        assert_eq!(compact_new_token_count(1_050_000), "1.1M new tks");
    }

    #[test]
    fn header_and_runs_panel_show_cache_excluding_token_usage() {
        let snapshot = json!({
            "run": {
                "id": "run-1",
                "goal": "Build the notes app",
                "status": "active",
                "run_type_id": "small",
                "run_type_title": "Original Research Sprint With A Long Name"
            },
            "token_usage": {
                "input_tokens": 1_000_000,
                "cached_input_tokens": 800_000,
                "output_tokens": 50_000,
                "total_tokens": 1_050_000,
                "new_tokens": 250_000
            },
            "tickets": [],
            "graph": []
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        let runs = operate_layout(Rect::new(0, 4, 120, 27)).runs;
        assert!(
            (runs.y..runs.bottom())
                .any(|row| rendered_row(&terminal, row).contains("250K new tks")),
            "token badge was clipped outside Runs {runs:?}: {rendered}"
        );
        assert!(
            !(runs.y..runs.bottom()).any(|row| rendered_row(&terminal, row).contains("1.1M tks")),
            "Runs must not headline the provider total: {rendered}"
        );
        assert!(
            (0..4).any(|row| rendered_row(&terminal, row).contains("250K new tks")),
            "header must show cache-excluding usage: {rendered}"
        );
    }

    #[test]
    fn run_overview_leads_with_new_usage_and_labels_provider_telemetry() {
        let snapshot = json!({
            "run":{"id":"run-1","goal":"Build it","status":"active","profile_id":"default"},
            "token_usage": {
                "input_tokens": 1_000,
                "cached_input_tokens": 800,
                "output_tokens": 100,
                "reasoning_output_tokens": 25,
                "total_tokens": 1_100,
                "new_tokens": 300
            },
            "tickets":[],
            "graph":[]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let run = &model.runs[0];
        let summary = run.summary.as_ref().unwrap();
        let overview = run_overview_text(run, summary, "Default", &model)
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            overview.contains("300 tks new · cache excluded"),
            "{overview}"
        );
        assert!(
            overview.contains("Uncached input 200 tks · output 100 tks · reasoning 25 tks"),
            "{overview}"
        );
        assert!(
            overview.contains("Cached input 800 tks · provider total 1.1K tks"),
            "{overview}"
        );
    }

    #[test]
    fn processed_planning_budget_is_not_labeled_new() {
        let snapshot = json!({
            "run": {"id":"run-1","goal":"Plan it","status":"planning","run_type_id":"small"},
            "planning_session": {
                "budget_metric": "processed_tokens",
                "budget_limit": 2_000,
                "synthesis_reserve": 500,
                "usage": {"total_tokens": 1_100, "new_tokens": 300},
                "accounted_baseline": {"total_tokens": 100, "new_tokens": 50}
            },
            "tickets":[],
            "graph":[]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(140, 36);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("1K/2K processed"), "{rendered}");
        assert!(!rendered.contains("1K/2K new"), "{rendered}");
    }

    #[test]
    fn operate_layout_keeps_graph_and_metadata_separate() {
        let snapshot = json!({
            "run":{"id":"run-1","goal":"Build it","status":"active","profile_id":"default"},
            "graph":[{"id":"root","type":"task","title":"Root","edges":{}}],
            "tickets":[{"id":"TK-1","title":"Ticket","status":"in_progress","operation":"build","workflow":[],"outputs":[],"blockers":[],"lease":null}]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("KONI"));
        assert!(rendered.contains("Project graph"));
        assert!(rendered.contains("Details: Overview - Plan - Stages"));
        assert!(rendered.contains("/tmp/project"));
        assert!(!rendered.contains("Ticket checkout is ready"));
        let details = rendered_cell_position(&terminal, "Details: Overview").unwrap();
        let agents = rendered_cell_position(&terminal, "Agents").unwrap();
        let activity = rendered_cell_position(&terminal, "Recent activity").unwrap();
        let graph = rendered_cell_position(&terminal, "Project graph").unwrap();
        assert!(
            agents.0 < details.0,
            "agents={agents:?}, details={details:?}"
        );
        assert!(
            agents.1 > details.1,
            "agents={agents:?}, details={details:?}"
        );
        assert!(
            details.0 < activity.0,
            "details={details:?}, activity={activity:?}"
        );
        assert!(
            activity.1 < graph.1,
            "activity={activity:?}, graph={graph:?}"
        );
        assert!(details.0 < graph.0, "details={details:?}, graph={graph:?}");
    }

    #[test]
    fn approval_review_uses_neutral_title_and_complete_section_navigation_help() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-review","goal":"Review safely","status":"planning"},
                "stages":[
                    {
                        "status":"succeeded",
                        "definition":{"id":"combined-plan","kind":"planning","title":"Combined plan","required":true},
                        "output":{"output":{"output":"Architecture, risk, and verification plan"}}
                    },
                    {"status":"pending","definition":{"id":"approval","kind":"manual","title":"Approve"}}
                ]
            }),
        );
        model.open_selected_run_approval();

        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Review plan"), "{rendered}");
        assert!(
            !rendered.contains("Review planning and approve"),
            "{rendered}"
        );
        let controls = "←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc";
        assert_eq!(UnicodeWidthStr::width(controls), 65);
        assert!(rendered.contains(controls), "{rendered}");
    }

    #[test]
    fn approval_revision_editor_wraps_steering_and_shows_one_adaptive_action() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-revise","goal":"Revise safely","status":"planning"},
                "stages":[
                    {
                        "status":"succeeded",
                        "definition":{"id":"combined-plan","kind":"planning","title":"Combined plan","required":true},
                        "output":{"output":{"output":"Architecture, risk, and verification plan"}}
                    },
                    {"status":"pending","definition":{"id":"approval","kind":"manual","title":"Approve"}}
                ]
            }),
        );
        model.open_selected_run_approval();
        let steering = "Preserve current API behavior while changing storage boundaries and maintaining compatibility through the migration.\nRequire a rollback check and targeted regression coverage.";
        let Some(Dialog::Approval(approval)) = model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.revision = steering.to_owned();
        approval.revision_cursor = steering.chars().count();
        approval.revision_focused = true;

        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let row_containing = |needle: &str| {
            (0..24)
                .find(|row| {
                    (0..82)
                        .filter_map(|column| terminal.backend().buffer().cell((column, *row)))
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains(needle)
                })
                .unwrap_or_else(|| panic!("missing {needle}"))
        };
        let first_line = row_containing("Preserve current API behavior");
        let wrapped_line = row_containing("through the migration");
        let explicit_second_line = row_containing("Require a rollback check");
        assert!(wrapped_line > first_line);
        assert!(explicit_second_line > wrapped_line);

        let button_row = row_containing("Revise plan");
        let button_text = (0..82)
            .filter_map(|column| terminal.backend().buffer().cell((column, button_row)))
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(button_text.contains("Revise plan"), "{button_text}");
        assert!(!button_text.contains("Approve run"), "{button_text}");
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("Enter newline"), "{rendered}");
        assert!(rendered.contains('▏'), "{rendered}");
    }

    #[test]
    fn approval_review_is_informed_scrollable_and_id_free_at_compact_and_roomy_sizes() {
        let verification = (1..=30)
            .map(|line| format!("Verification evidence line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let snapshot = json!({
            "project_root":"/tmp/private-project-path",
            "run":{
                "id":"run-secret-019f",
                "goal":"Prove sortedness behavior",
                "status":"planning",
                "run_type_title":"Large Research"
            },
            "questions":[{
                "id":"question-secret-019f",
                "status":"answered",
                "prompt":"How should invalid inputs be rejected?",
                "options":[{"id":"choice-secret","label":"Raise TypeError","recommended":true}],
                "answer":{"option_id":"choice-secret"},
                "session_resume":{"session_id":"session-secret"}
            }],
            "stages":[
                {
                    "status":"succeeded",
                    "definition":{"id":"architecture-secret","kind":"planning","title":"Plan architecture","required":true},
                    "output":{"output":{"output":"Architecture contract body"}}
                },
                {
                    "status":"succeeded",
                    "definition":{"id":"risk-secret","kind":"planning","title":"Plan risk controls","required":true},
                    "output":{"output":{"output":"Risk controls body"}}
                },
                {
                    "status":"succeeded",
                    "definition":{"id":"verification-secret","kind":"planning","title":"Plan verification","required":true},
                    "output":{"output":{
                        "output":verification,
                        "graph_seed":{
                            "root_spec":{
                                "acceptance_intent":"Acceptance remains explicit",
                                "source_path":"/tmp/seed-root-secret",
                                "graph_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            },
                            "nodes":[{
                                "key":"seed-key-secret",
                                "type":"change",
                                "title":"Preserve sortedness behavior",
                                "spec":{
                                    "purpose":"Keep the shared ordering contract explicit",
                                    "path":"src/private-seed.rs"
                                }
                            }],
                            "edges":[{
                                "source":"$root",
                                "relation":"decomposes_into",
                                "target":"seed-key-secret"
                            }]
                        }
                    }}
                }
            ],
            "agents":[{
                "id":"agent-secret",
                "stage_id":"risk-secret",
                "pid":424242,
                "working_directory":"/tmp/agent-path-secret"
            }]
        });
        let mut compact_model =
            ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot.clone());
        compact_model.open_selected_run_approval();
        let compact_backend = TestBackend::new(82, 24);
        let mut compact = Terminal::new(compact_backend).unwrap();
        compact.draw(|frame| draw(frame, &compact_model)).unwrap();
        let compact_text = rendered_text(&compact);
        for visible in [
            "Review plan",
            "Architecture",
            "Risk",
            "Verification",
            "Graph Seed",
            "Architecture contract body",
            "Approve run",
            "←→/[] sections",
            "↑↓/jk/PgUp/PgDn scroll",
        ] {
            assert!(
                compact_text.contains(visible),
                "missing {visible}: {compact_text}"
            );
        }
        assert!(
            !compact_text.contains("Review planning and approve"),
            "{compact_text}"
        );
        assert!(!compact_text.contains("Decisions"), "{compact_text}");
        assert!(!compact_text.contains("Revise plan"), "{compact_text}");
        assert!(
            !compact_text.contains("Structured planner output"),
            "{compact_text}"
        );
        let Some(Dialog::Approval(approval)) = compact_model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.selected_section = approval
            .sections
            .iter()
            .position(|section| section.title == "Graph Seed")
            .expect("Graph Seed tab remains selectable at the compact size");
        let graph_seed_backend = TestBackend::new(82, 24);
        let mut compact_graph_seed = Terminal::new(graph_seed_backend).unwrap();
        compact_graph_seed
            .draw(|frame| draw(frame, &compact_model))
            .unwrap();
        let compact_graph_seed_text = rendered_text(&compact_graph_seed);
        for visible in [
            "Graph Seed",
            "3 root facts · 1 semantic node · 1 relationship",
            "Acceptance intent: Acceptance remains explicit",
        ] {
            assert!(
                compact_graph_seed_text.contains(visible),
                "missing {visible}: {compact_graph_seed_text}"
            );
        }
        let Some(Dialog::Approval(approval)) = compact_model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.scroll = 5;
        let scrolled_graph_seed_backend = TestBackend::new(82, 24);
        let mut scrolled_compact_graph_seed = Terminal::new(scrolled_graph_seed_backend).unwrap();
        scrolled_compact_graph_seed
            .draw(|frame| draw(frame, &compact_model))
            .unwrap();
        let scrolled_graph_seed_text = rendered_text(&scrolled_compact_graph_seed);
        for visible in [
            "Preserve sortedness behavior",
            "Keep the shared ordering contract explicit",
        ] {
            assert!(
                scrolled_graph_seed_text.contains(visible),
                "missing {visible}: {scrolled_graph_seed_text}"
            );
        }
        let Some(Dialog::Approval(approval)) = compact_model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.scroll = 10;
        let tail_graph_seed_backend = TestBackend::new(82, 24);
        let mut tail_compact_graph_seed = Terminal::new(tail_graph_seed_backend).unwrap();
        tail_compact_graph_seed
            .draw(|frame| draw(frame, &compact_model))
            .unwrap();
        let tail_graph_seed_text = rendered_text(&tail_compact_graph_seed);
        {
            let visible = "Objective → decomposes into → Preserve sortedness behavior";
            assert!(
                tail_graph_seed_text.contains(visible),
                "missing {visible}: {tail_graph_seed_text}"
            );
        }
        let Some(Dialog::Approval(approval)) = compact_model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.scroll = usize::MAX;
        let end_graph_seed_backend = TestBackend::new(82, 24);
        let mut end_compact_graph_seed = Terminal::new(end_graph_seed_backend).unwrap();
        end_compact_graph_seed
            .draw(|frame| draw(frame, &compact_model))
            .unwrap();
        let end_graph_seed_text = rendered_text(&end_compact_graph_seed);
        assert!(
            end_graph_seed_text.contains("2 root facts · 0 nodes · 0 relationships"),
            "{end_graph_seed_text}"
        );

        let mut roomy_model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        roomy_model.open_selected_run_approval();
        let expected = [
            (0, "Architecture contract body"),
            (1, "Risk controls body"),
            (2, "Verification evidence line 1"),
            (3, "3 root facts · 1 semantic node · 1 relationship"),
        ];
        let mut all_rendered = String::new();
        for (section, body) in expected {
            let Some(Dialog::Approval(approval)) = roomy_model.dialog.as_mut() else {
                panic!("approval review did not open");
            };
            approval.selected_section = section;
            approval.scroll = 0;
            let roomy_backend = TestBackend::new(140, 36);
            let mut roomy = Terminal::new(roomy_backend).unwrap();
            roomy.draw(|frame| draw(frame, &roomy_model)).unwrap();
            let text = rendered_text(&roomy);
            assert!(
                text.contains(body),
                "section {section} missing {body}: {text}"
            );
            all_rendered.push_str(&text);
        }

        let Some(Dialog::Approval(approval)) = roomy_model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.selected_section = 2;
        approval.scroll = 4;
        let scrolled_backend = TestBackend::new(140, 36);
        let mut scrolled = Terminal::new(scrolled_backend).unwrap();
        scrolled.draw(|frame| draw(frame, &roomy_model)).unwrap();
        let scrolled_text = rendered_text(&scrolled);
        assert!(
            scrolled_text.contains("Verification evidence line 5"),
            "{scrolled_text}"
        );
        assert!(
            !scrolled_text.contains("Verification evidence line 30"),
            "{scrolled_text}"
        );
        assert!(!scrolled_text.contains("Lines "), "{scrolled_text}");

        all_rendered.push_str(&scrolled_text);
        for secret in [
            "run-secret",
            "question-secret",
            "choice-secret",
            "architecture-secret",
            "risk-secret",
            "verification-secret",
            "agent-secret",
            "session-secret",
            "424242",
            "private-project-path",
            "agent-path-secret",
            "seed-key-secret",
            "seed-root-secret",
            "private-seed.rs",
            "0123456789abcdef",
        ] {
            assert!(!all_rendered.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn approval_review_visibly_disables_action_when_a_required_pass_is_missing() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Build safely","status":"planning"},
                "stages":[{
                    "status":"waiting",
                    "definition":{"id":"risk-secret","kind":"planning","title":"Plan risk controls","required":true}
                }]
            }),
        );
        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = model.dialog.as_mut() else {
            panic!("approval review did not open");
        };
        approval.action_focused = true;
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("Approve run"), "{rendered}");
        assert!(
            rendered.contains("Plan risk controls is incomplete"),
            "{rendered}"
        );
        assert!(!rendered.contains("risk-secret"), "{rendered}");
    }

    #[test]
    fn operate_layout_conditionally_splits_questions_and_keeps_graph_at_82x24() {
        let area = Rect::new(0, 4, 82, 19);
        let quiet = operate_layout_with_questions(area, false);
        assert!(quiet.pending_questions.is_none());
        assert_eq!(quiet.details.y, area.y);
        assert_eq!(quiet.details.height, area.height);
        assert_eq!(quiet.active_agents.x, quiet.runs.x);
        assert!(quiet.active_agents.y > quiet.tickets.y);
        assert_eq!(quiet.activity.y, area.y);
        assert!(quiet.activity.y < quiet.graph.y);
        assert!(quiet.graph.height > 0);

        let pending = operate_layout_with_questions(area, true);
        let questions = pending.pending_questions.unwrap();
        assert_eq!(pending.details.x, questions.x);
        assert_eq!(pending.details.width, questions.width);
        assert_eq!(pending.details.height + questions.height, area.height);
        assert!(pending.details.height > questions.height);
        assert_eq!(pending.graph, quiet.graph);

        for width in 82..120 {
            let layout = operate_layout_with_questions(Rect::new(0, 4, width, 19), false);
            assert_eq!(layout.details.width, layout.activity.width, "width {width}");
            assert_eq!(layout.details.width, layout.graph.width, "width {width}");
        }
        for width in 120..=181 {
            let layout = operate_layout_with_questions(Rect::new(0, 4, width, 19), false);
            assert_eq!(layout.details.width, layout.graph.width, "width {width}");
            assert!(layout.runs.width >= layout.details.width, "width {width}");
            assert!(layout.runs.width.saturating_sub(layout.details.width) <= 2);
            assert_eq!(
                layout.runs.width + layout.details.width + layout.graph.width,
                width,
                "width {width}"
            );
        }
    }

    #[test]
    fn compact_details_carousel_stays_distinct_from_pending_questions() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Build notes","status":"planning"},
            "questions":[{
                "id":"question-secret",
                "status":"open",
                "prompt":"Choose storage",
                "options":[{"id":"local","label":"Local","recommended":true}]
            }]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        for panel in Panel::ALL {
            model.detail_panel = panel;
            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let rendered = rendered_text(&terminal);
            assert!(rendered.contains("D:Overview-Plan-Stages"), "{rendered}");
            assert!(rendered.contains("Questions"), "{rendered}");
            let layout = operate_layout_with_questions(Rect::new(0, 4, 82, 15), true);
            let tabs = rendered_row(&terminal, layout.detail_switcher.y);
            for label in ["Overview", "Plan", "Stages"] {
                assert!(
                    tabs.contains(label),
                    "missing {label} from visible tabs: {tabs}"
                );
            }
        }
    }

    #[test]
    fn compact_dashboard_reclaims_details_when_the_final_pending_question_disappears() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Build notes","status":"planning"},
            "questions":[{
                "id":"question-secret",
                "status":"open",
                "prompt":"Choose storage",
                "options":[{"id":"local","label":"Local","recommended":true}]
            }],
            "graph":[{"id":"node-secret","type":"task","title":"Notes","edges":{}}]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus = Focus::Questions;
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let pending = rendered_text(&terminal);
        assert!(pending.contains("Questions"), "{pending}");
        assert!(pending.contains("Choose storage"), "{pending}");
        assert!(pending.contains("Project graph"), "{pending}");

        model.runs[model.selected_run].questions.clear();
        model.normalize_conditional_focus();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let settled = rendered_text(&terminal);
        assert_eq!(model.focus, Focus::Details);
        assert!(!settled.contains("Questions"), "{settled}");
        assert!(!settled.contains("Choose storage"), "{settled}");
        assert!(settled.contains("D:Overview-Plan-Stages"), "{settled}");
        assert!(settled.contains("Project graph"), "{settled}");

        let area = Rect::new(0, 4, 82, 15);
        let quiet = operate_layout_with_questions(area, false);
        assert_eq!(quiet.details.height, area.height);
    }

    #[test]
    fn compact_operate_dashboard_shows_friendly_live_work_and_pending_question_without_ids() {
        let snapshot = json!({
            "run":{"id":"run-secret-019f","goal":"Build notes","status":"planning"},
            "stages":[{
                "status":"running",
                "definition":{"id":"stage-secret-019f","title":"Plan risk controls"}
            }],
            "agents":[
                {
                    "id":"agent-secret-019f",
                    "stage_id":"stage-secret-019f",
                    "persona":"planner",
                    "model":"internal-model-name",
                    "status":"running"
                },
                {
                    "id":"waiting-secret-019f",
                    "persona":"reviewer",
                    "status":"waiting"
                }
            ],
            "questions":[{
                "id":"question-secret-019f",
                "status":"open",
                "prompt":"Should notes sync offline?",
                "options":[{"id":"yes-secret","label":"Support offline","recommended":true}]
            }],
            "graph":[{"id":"node-secret-019f","type":"task","title":"Notes","edges":{}}]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Agents 1 / 2 active"), "{rendered}");
        assert!(rendered.contains("Run · Planner"), "{rendered}");
        assert!(rendered.contains("Reviewer"), "{rendered}");
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(rendered_cell_position(&terminal, "Run · Planner").unwrap())
                .unwrap()
                .fg,
            Color::White
        );
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(rendered_cell_position(&terminal, "Reviewer").unwrap())
                .unwrap()
                .fg,
            Color::DarkGray
        );
        assert!(rendered.contains("Questions"), "{rendered}");
        assert!(rendered.contains("←→/[]"), "{rendered}");
        assert!(rendered.contains("↑↓/jk"), "{rendered}");
        let question_panel = operate_layout_with_questions(Rect::new(0, 4, 82, 19), true)
            .pending_questions
            .expect("question panel should be visible");
        assert_eq!(
            rendered_cell_position(&terminal, "←→/[]")
                .expect("question controls should render")
                .1,
            question_panel.bottom() - 1,
            "question controls must stay on the panel's bottom edge"
        );
        assert!(rendered.contains("Should notes sync"), "{rendered}");
        assert!(rendered.contains("Project graph"), "{rendered}");
        for secret in [
            "run-secret",
            "stage-secret",
            "agent-secret",
            "waiting-secret",
            "question-secret",
            "internal-model-name",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
    }

    #[test]
    fn batched_questions_render_as_a_horizontal_carousel_with_labeled_options() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Resolve API behavior","status":"planning"},
            "questions":[
                {
                    "id":"question-two-secret",
                    "status":"answered_pending_resume",
                    "prompt":"Choose element policy",
                    "batch":{"id":"batch-secret-019f","ordinal":2,"size":3},
                    "options":[{"id":"strict","label":"Strict integers","description":"Reject bool and mixed elements.","recommended":true}],
                    "answer":{"option_id":"strict"}
                },
                {
                    "id":"question-three-secret",
                    "status":"open",
                    "prompt":"Choose corpus boundary",
                    "batch":{"id":"batch-secret-019f","ordinal":3,"size":3},
                    "options":[{"id":"bounded","label":"Bounded corpus","description":"Use a finite reproducible corpus.","recommended":true}]
                },
                {
                    "id":"question-one-secret",
                    "status":"open",
                    "prompt":"Choose rejection behavior",
                    "batch":{"id":"batch-secret-019f","ordinal":1,"size":3},
                    "options":[{"id":"raise","label":"Raise TypeError","description":"Reject unsupported inputs before iteration.","recommended":true}]
                }
            ]
        });

        let mut compact_model =
            ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot.clone());
        let compact_backend = TestBackend::new(82, 24);
        let mut compact = Terminal::new(compact_backend).unwrap();
        compact.draw(|frame| draw(frame, &compact_model)).unwrap();
        let compact_text = rendered_text(&compact);
        assert!(compact_text.contains("1/3"), "{compact_text}");
        assert!(
            compact_text.contains("Choose rejection behavior"),
            "{compact_text}"
        );
        assert!(compact_text.contains("Raise TypeError"), "{compact_text}");
        assert!(compact_text.contains("Reject uns"), "{compact_text}");
        assert!(
            !compact_text.contains("Choose element policy"),
            "{compact_text}"
        );
        assert!(!compact_text.contains("batch-secret"), "{compact_text}");
        assert_eq!(
            compact
                .backend()
                .buffer()
                .cell(rendered_cell_position(&compact, "Reject uns").unwrap())
                .unwrap()
                .fg,
            Color::DarkGray
        );

        compact_model.select_next_question(1);
        compact.draw(|frame| draw(frame, &compact_model)).unwrap();
        let second = rendered_text(&compact);
        assert!(second.contains("2/3"), "{second}");
        assert!(second.contains("Choose element policy"), "{second}");
        assert_eq!(
            compact
                .backend()
                .buffer()
                .cell(rendered_cell_position(&compact, "Choose element").unwrap())
                .unwrap()
                .fg,
            Color::White
        );

        let mut roomy_model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let roomy_backend = TestBackend::new(140, 36);
        let mut roomy = Terminal::new(roomy_backend).unwrap();
        for (position, prompt) in [
            ("1/3", "Choose rejection behavior"),
            ("2/3", "Choose element policy"),
            ("3/3", "Choose corpus boundary"),
        ] {
            roomy.draw(|frame| draw(frame, &roomy_model)).unwrap();
            let text = rendered_text(&roomy);
            assert!(text.contains(position), "missing {position}: {text}");
            assert!(text.contains(prompt), "missing {prompt}: {text}");
            if position == "2/3" {
                assert!(text.contains("✓ Answer recorded"), "{text}");
            }
            assert!(!text.contains("batch-secret"), "{text}");
            roomy_model.select_next_question(1);
        }
    }

    #[test]
    fn saved_batch_answer_modal_wraps_research_copy_and_exposes_revision_controls() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Resolve contract","status":"planning"},
                "questions":[
                    {
                        "id":"saved-secret",
                        "status":"answered_pending_resume",
                        "prompt":"What deterministic contract should apply when a finite input list contains a value outside the declared integer domain, including language-specific Boolean subtypes?",
                        "context":"This decision changes the hypothesis boundary, the negative-input evidence matrix, and every verification gate that distinguishes invalid data from a valid unsorted sequence.",
                        "batch":{"id":"batch-secret","ordinal":1,"size":2},
                        "options":[
                            {
                                "id":"strict",
                                "label":"Strict integers",
                                "description":"Reject every out-of-domain element before comparing adjacent pairs so the failure mode remains deterministic across every position in the input.",
                                "recommended":true
                            },
                            {
                                "id":"precondition",
                                "label":"Precondition only",
                                "description":"Keep invalid elements outside the scientific claim.",
                                "recommended":false
                            }
                        ],
                        "answer":{"option_id":"strict"}
                    },
                    {
                        "id":"open-secret",
                        "status":"open",
                        "prompt":"Choose the public module",
                        "batch":{"id":"batch-secret","ordinal":2,"size":2},
                        "options":[{"id":"module","label":"Module","description":"Use one module","recommended":true}]
                    }
                ]
            }),
        );
        model.open_pending_question(0);
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Revise answer"), "{rendered}");
        assert!(rendered.contains("Saved draft"), "{rendered}");
        assert!(rendered.contains("language-specific Boolean"), "{rendered}");
        assert!(rendered.contains("valid unsorted sequence"), "{rendered}");
        assert!(
            rendered.contains("every position in the input"),
            "{rendered}"
        );
        assert!(rendered.contains("Notes (optional)"), "{rendered}");
        assert!(rendered.contains("None of the above"), "{rendered}");
        assert!(!rendered.contains("saved-secret"), "{rendered}");
        assert!(!rendered.contains("batch-secret"), "{rendered}");
    }

    #[test]
    fn agents_panel_scrolls_live_first_then_muted_history_without_ids() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Build notes","status":"active"},
                "stages":[
                    {"definition":{"id":"live-stage-secret","title":"Build note editor"}},
                    {"definition":{"id":"old-stage-a-secret","title":"Validate data model"}},
                    {"definition":{"id":"old-stage-b-secret","title":"Plan local storage"}},
                    {"definition":{"id":"old-stage-c-secret","title":"Review sync behavior"}},
                    {"definition":{"id":"old-stage-d-secret","title":"Check keyboard flow"}},
                    {"definition":{"id":"old-stage-e-secret","title":"Map app structure"}}
                ],
                "agents":[
                    {"id":"live-agent-secret","stage_id":"live-stage-secret","persona":"builder","status":"running","updated_at":"2026-07-11T12:06:00Z"},
                    {"id":"old-agent-a-secret","stage_id":"old-stage-a-secret","persona":"validator","status":"completed","updated_at":"2026-07-11T12:05:00Z"},
                    {"id":"old-agent-b-secret","stage_id":"old-stage-b-secret","persona":"planner","status":"completed","updated_at":"2026-07-11T12:04:00Z"},
                    {"id":"old-agent-c-secret","stage_id":"old-stage-c-secret","persona":"reviewer","status":"completed","updated_at":"2026-07-11T12:03:00Z"},
                    {"id":"old-agent-d-secret","stage_id":"old-stage-d-secret","persona":"tester","status":"completed","updated_at":"2026-07-11T12:02:00Z"},
                    {"id":"old-agent-e-secret","stage_id":"old-stage-e-secret","persona":"mapper","status":"completed","updated_at":"2026-07-11T12:01:00Z"}
                ]
            }),
        );
        model.focus = Focus::Agents;
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let first = rendered_text(&terminal);
        assert!(first.contains("Agents 1 / 6 active"), "{first}");
        assert!(first.contains("Run · Builder"), "{first}");
        assert!(!first.contains("Run · Mapper"), "{first}");

        model.selected_agent = 5;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let scrolled = rendered_text(&terminal);
        assert!(scrolled.contains("Run · Mapper"), "{scrolled}");
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(rendered_cell_position(&terminal, "Run · Mapper").unwrap())
                .unwrap()
                .fg,
            Color::DarkGray
        );
        for secret in ["live-agent-secret", "old-agent", "stage-secret"] {
            assert!(!scrolled.contains(secret), "leaked {secret}: {scrolled}");
        }
    }

    #[test]
    fn agents_panel_follows_run_or_ticket_selection_scope() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Build notes","status":"active"},
                "tickets":[
                    {"id":"notes-ticket","title":"Build note editor","status":"in_progress","workflow":[],"outputs":[]},
                    {"id":"search-ticket","title":"Add note search","status":"in_progress","workflow":[],"outputs":[]}
                ],
                "agents":[
                    {"id":"notes-lead","ticket_id":"notes-ticket","persona":"lead","status":"running"},
                    {"id":"search-lead","ticket_id":"search-ticket","persona":"lead","status":"running"},
                    {"id":"run-reviewer","persona":"reviewer","status":"completed"}
                ]
            }),
        );
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();

        model.focus_runs();
        model.focus_agents();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let run_scope = rendered_text(&terminal);
        assert!(
            run_scope.contains("Build note editor · Lead"),
            "{run_scope}"
        );
        assert!(run_scope.contains("Add note search · Lead"), "{run_scope}");
        assert!(run_scope.contains("Run · Reviewer"), "{run_scope}");

        model.focus_tickets();
        model.focus_agents();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let ticket_scope = rendered_text(&terminal);
        assert!(ticket_scope.contains("Agents"), "{ticket_scope}");
        assert!(ticket_scope.contains("1 / 1 active"), "{ticket_scope}");
        assert!(ticket_scope.contains("Lead"), "{ticket_scope}");
        assert!(
            ticket_scope.contains("Lead · Build note editor"),
            "{ticket_scope}"
        );
        assert!(
            !ticket_scope.contains("Add note search · Lead"),
            "{ticket_scope}"
        );
        assert!(!ticket_scope.contains("Reviewer"), "{ticket_scope}");
    }

    #[test]
    fn focusing_an_agent_turns_details_into_a_full_codex_style_chat_view() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join(".git/koni/agents/worker.jsonl");
        let prompt = root.path().join(".git/koni/agents/prompt.md");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&prompt, "Inspect **the runtime** before editing.").unwrap();
        std::fs::write(
            &transcript,
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"older-session-secret\"}\n",
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Older step transcript must stay hidden.\"}}\n",
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":999999,\"output_tokens\":999999}}\n",
                "{\"type\":\"thread.started\",\"thread_id\":\"session-secret\"}\n",
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Mapped the runtime prerequisites.\"}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\",\"tool\":\"spawn_worker\",\"status\":\"failed\",\"result\":{\"content\":[{\"text\":\"internal-secret\"}]}}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\",\"tool\":\"yield_lead\",\"arguments\":{\"grant\":\"grant-secret\"}}}\n",
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1200,\"output_tokens\":300}}\n"
            ),
        )
        .unwrap();
        let mut model = ControlCenterModel::from_snapshot(
            root.path().to_path_buf(),
            json!({
                "run":{"id":"run-secret","goal":"Research sortedness","status":"active"},
                "stages":[{"definition":{"id":"stage-secret","title":"Map prerequisites"}}],
                "agents":[{
                    "id":"agent-secret",
                    "stage_id":"stage-secret",
                    "persona":"builder",
                    "status":"running",
                    "stdout_path":transcript.display().to_string(),
                    "prompt_path":prompt.display().to_string(),
                    "codex_session_id":"session-secret"
                }]
            }),
        );
        model.focus_runs();
        model.focus_agents();
        let backend = TestBackend::new(120, 34);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let chat = rendered_text(&terminal);
        assert!(chat.contains("Chat · Builder"), "{chat}");
        assert!(
            chat.contains("Inspect **the runtime** before") && chat.contains("editing."),
            "{chat}"
        );
        assert!(
            chat.contains("Mapped the runtime") && chat.contains("prerequisites."),
            "{chat}"
        );
        assert!(!chat.contains("Older step transcript"), "{chat}");
        assert!(!chat.contains("999.9K"), "{chat}");
        assert!(chat.contains("Call failed Spawn worker"), "{chat}");
        assert!(chat.contains("Called Yield lead"), "{chat}");
        assert!(!chat.contains("grant-secret"), "{chat}");
        assert!(!chat.contains("internal-secret"), "{chat}");
        assert!(chat.contains("1.2K tks in · 300 tks out"), "{chat}");
        for secret in ["session-secret", "agent-secret", "stage-secret"] {
            assert!(!chat.contains(secret), "leaked {secret}: {chat}");
        }
        assert!(
            !chat.contains(transcript.to_string_lossy().as_ref()),
            "{chat}"
        );

        model.focus = Focus::Details;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let focused_chat = rendered_text(&terminal);
        assert!(focused_chat.contains("Chat · Builder"), "{focused_chat}");
        assert!(
            focused_chat.contains("Mapped the runtime") && focused_chat.contains("prerequisites."),
            "{focused_chat}"
        );

        model.close_agent_chat();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let overview = rendered_text(&terminal);
        assert!(
            overview.contains("Details: Overview - Plan - Stages"),
            "{overview}"
        );
        assert!(!overview.contains("Chat · Builder"), "{overview}");
    }

    #[test]
    fn live_agent_chat_styles_compiler_mediated_guidance_as_a_user_message() {
        let root = tempfile::tempdir().unwrap();
        let mut model = ControlCenterModel::from_snapshot(
            root.path().to_path_buf(),
            json!({
                "run":{"id":"run-secret","goal":"Research sortedness","status":"active"},
                "tickets":[{
                    "id":"ticket-secret",
                    "title":"Validate boundary semantics",
                    "status":"in_progress",
                    "workflow":[],
                    "outputs":[]
                }],
                "agents":[{
                    "id":"agent-secret",
                    "ticket_id":"ticket-secret",
                    "persona":"reviewer",
                    "status":"running"
                }],
                "events":[{
                    "id":"event-secret",
                    "type":"compiler.steering.recorded",
                    "ticket_id":"ticket-secret",
                    "data":{
                        "kind":"agent_chat",
                        "message":"Check the negative-count verdict.",
                        "ticket_id":"ticket-secret"
                    }
                }],
                "actions":[{
                    "id":"steer",
                    "params":{
                        "kind":{"type":"string","required":true},
                        "message":{"type":"string","required":true},
                        "ticket_id":{"type":"ticket_id","required":false},
                        "target_nodes":{"type":"json","default":[]},
                        "priority":{"type":"string","default":"normal"}
                    }
                }]
            }),
        );
        model.focus_tickets();
        model.focus_agents();
        let backend = TestBackend::new(120, 34);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let chat = rendered_text(&terminal);
        assert!(
            chat.contains("Check the negative-count") && chat.contains("verdict."),
            "{chat}"
        );
        assert!(!chat.contains("Working on"), "{chat}");
        assert!(rendered_row(&terminal, 33).contains("Enter message"));

        let mut form = model.agent_guidance_form().unwrap();
        assert!(form.is_agent_guidance());
        assert_eq!(form.params[form.selected].id, "message");
        assert_eq!(
            form.params
                .iter()
                .find(|param| param.id == "ticket_id")
                .map(|param| param.value.as_str()),
            Some("ticket-secret")
        );
        form.params[form.selected].value = "Recheck the total verdict function.".to_owned();
        model.dialog = Some(Dialog::ActionForm(form));
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let composer = rendered_text(&terminal);
        assert!(composer.contains("Send agent guidance"), "{composer}");
        assert!(
            composer.contains("Recheck the total verdict function."),
            "{composer}"
        );
        assert!(composer.contains("selected ticket"), "{composer}");
        assert!(composer.contains("next compiler"), "{composer}");
        assert!(composer.contains("boundary."), "{composer}");
        for secret in [
            "run-secret",
            "ticket-secret",
            "agent-secret",
            "event-secret",
        ] {
            assert!(!composer.contains(secret), "leaked {secret}: {composer}");
        }

        if let Some(Dialog::ActionForm(form)) = model.dialog.as_mut() {
            for param in &mut form.params {
                if matches!(param.id.as_str(), "ticket" | "ticket_id") {
                    param.value.clear();
                }
            }
        }
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let lead_composer = rendered_text(&terminal);
        assert!(lead_composer.contains("selected run"), "{lead_composer}");
        assert!(
            !lead_composer.contains("selected ticket"),
            "{lead_composer}"
        );
    }

    #[test]
    fn operate_footer_shortcuts_follow_the_visual_panel_order() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose",
                    "options":[{"id":"safe","label":"Safe"}]
                }]
            }),
        );
        let backend = TestBackend::new(120, 28);
        let mut terminal = Terminal::new(backend).unwrap();

        for (focus, guidance) in [
            (Focus::Runs, "1 Runs"),
            (Focus::Tickets, "2 Tickets"),
            (Focus::Agents, "3 Agents"),
            (Focus::Details, "4 Details"),
            (Focus::Questions, "Questions"),
            (Focus::Activity, "5 Activity"),
            (Focus::Graph, "6 Graph"),
        ] {
            model.focus = focus;
            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let footer = rendered_row(&terminal, 27);
            assert!(footer.contains(guidance), "missing {guidance}: {footer}");
            assert!(
                footer.contains("h help"),
                "missing contextual help: {footer}"
            );
        }
    }

    #[test]
    fn compact_operate_footer_keeps_contextual_help_visible_before_long_status() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.status = "a deliberately long background status that must not hide the help affordance at the supported compact width".to_owned();
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let footer = rendered_row(&terminal, 19);

        assert!(footer.starts_with(" h help"), "{footer}");
    }

    #[test]
    fn footer_keeps_help_first_across_width_thresholds_and_wide_status_text() {
        for width in [82, 109, 110, 120, 181] {
            let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
            model.status =
                "研究📓 background status that is deliberately much longer than the footer"
                    .repeat(4);
            let backend = TestBackend::new(width, 20);
            let mut terminal = Terminal::new(backend).unwrap();

            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let footer = rendered_row(&terminal, 19);

            assert!(footer.starts_with(" h help"), "width {width}: {footer}");
            assert!(!footer.contains('\u{fffd}'), "width {width}: {footer}");
        }
    }

    #[test]
    fn compact_contextual_help_is_complete_and_never_exposes_internal_ids() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret-019f","goal":"Build notes","status":"active"},
                "graph":[{"id":"node-secret-019f","type":"task","title":"Notes"}]
            }),
        );
        model.dialog = Some(Dialog::Help(HelpTopic::ConfigEditor {
            domain: ConfigDomain::Agents,
            resource_kind: Some(crate::configure::ConfigResourceKind::NativeAgent),
            mode: crate::help::ConfigEditorMode::Source,
        }));
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(
            rendered.contains("Help · Source Editor · Codex agent"),
            "{rendered}"
        );
        assert!(rendered.contains("WHAT THIS IS"), "{rendered}");
        assert!(rendered.contains("IN THE WORKFLOW"), "{rendered}");
        assert!(rendered.contains("AVAILABLE HERE"), "{rendered}");
        assert!(rendered.contains("h is literal here"), "{rendered}");
        assert!(
            rendered.contains("Close: h · Esc · Enter · q · F1"),
            "{rendered}"
        );
        for secret in ["run-secret", "node-secret", "019f"] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
    }

    #[test]
    fn every_main_panel_help_topic_keeps_its_close_control_visible_in_compact_layout() {
        let mut topics = vec![
            HelpTopic::Runs,
            HelpTopic::Tickets,
            HelpTopic::PendingQuestions,
            HelpTopic::Agents,
            HelpTopic::Graph,
            HelpTopic::ConfigDomains,
        ];
        topics.extend(Panel::ALL.into_iter().map(HelpTopic::Details));
        topics.extend(
            ConfigDomain::ALL
                .into_iter()
                .map(|domain| HelpTopic::ConfigResources { domain }),
        );
        topics.extend([
            HelpTopic::ConfigEditor {
                domain: ConfigDomain::Agents,
                resource_kind: Some(crate::configure::ConfigResourceKind::NativeAgent),
                mode: crate::help::ConfigEditorMode::Guided,
            },
            HelpTopic::ConfigEditor {
                domain: ConfigDomain::Agents,
                resource_kind: Some(crate::configure::ConfigResourceKind::NativeAgent),
                mode: crate::help::ConfigEditorMode::LinkedInstructions,
            },
            HelpTopic::ConfigEditor {
                domain: ConfigDomain::Agents,
                resource_kind: Some(crate::configure::ConfigResourceKind::NativeAgent),
                mode: crate::help::ConfigEditorMode::Source,
            },
        ]);
        for resource_kind in crate::configure::ConfigResourceKind::ALL {
            topics.push(HelpTopic::ConfigEditor {
                domain: ConfigDomain::Advanced,
                resource_kind: Some(resource_kind),
                mode: crate::help::ConfigEditorMode::Source,
            });
        }

        for topic in topics {
            let content = topic.content();
            let expected_title = format!("Help · {}", content.title);
            let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
            model.dialog = Some(Dialog::Help(topic));
            let backend = TestBackend::new(82, 20);
            let mut terminal = Terminal::new(backend).unwrap();

            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let rendered = rendered_text(&terminal);

            assert!(rendered.contains(&expected_title), "{rendered}");
            assert!(rendered.contains("WHAT THIS IS"), "{rendered}");
            assert!(rendered.contains("IN THE WORKFLOW"), "{rendered}");
            assert!(rendered.contains("AVAILABLE HERE"), "{rendered}");
            for action in content.actions {
                assert!(
                    rendered.contains(&action.keys),
                    "compact help clipped key '{}' for {expected_title}: {rendered}",
                    action.keys
                );
                assert!(
                    rendered.contains(&action.description),
                    "compact help clipped action '{}' for {expected_title}: {rendered}",
                    action.description
                );
            }
            assert!(
                rendered.contains("Close: h · Esc · Enter · q · F1"),
                "compact help clipped its close control for {expected_title}: {rendered}"
            );
        }
    }

    #[test]
    fn compact_pending_questions_help_explains_selection_batches_and_resume() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret-019f","goal":"Build notes","status":"planning"},
                "questions":[{
                    "id":"question-secret-019f",
                    "status":"open",
                    "prompt":"Choose the contract",
                    "options":[{"id":"option-secret","label":"Safe"}]
                }]
            }),
        );
        model.focus = Focus::Questions;
        model.dialog = Some(Dialog::Help(HelpTopic::PendingQuestions));
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Help · Pending Questions"), "{rendered}");
        assert!(rendered.contains("final unanswered member"), "{rendered}");
        assert!(rendered.contains("Enter / ?"), "{rendered}");
        assert!(
            rendered.contains("Resolve due automatic answers"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Close: h · Esc · Enter · q · F1"),
            "{rendered}"
        );
        for secret in ["run-secret", "question-secret", "option-secret", "019f"] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
    }

    #[test]
    fn compact_runs_help_uses_current_new_run_language() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.dialog = Some(Dialog::Help(HelpTopic::Runs));
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Help · Runs"), "{rendered}");
        assert!(rendered.contains("Objective"), "{rendered}");
        assert!(rendered.contains("Run Config"), "{rendered}");
        assert!(!rendered.contains("guided intake"), "{rendered}");
    }

    #[test]
    fn compact_runs_help_adds_selected_run_orchestration_controls_without_protected_keys() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run": {
                    "id": "run-secret-019f",
                    "goal": "Exercise configured controls",
                    "status": "active"
                },
                "orchestration": {
                    "running": true,
                    "max_parallel": 2,
                    "unchained": false
                },
                "views": [{
                    "id": "orchestration-secret-019f",
                    "kind": "controls",
                    "options": {"keybindings": {
                        "toggle": "space",
                        "parallel_2": "-",
                        "parallel_4": "+",
                        "parallel_99": "h",
                        "parallel_100": "zz",
                        "unchained": "u"
                    }}
                }]
            }),
        );
        model.focus = Focus::Runs;
        model.dialog = Some(Dialog::Help(HelpTopic::Runs));

        let actions = configured_runs_orchestration_help_actions(&model);
        assert!(actions.iter().any(|action| {
            action.keys == "Space" && action.description == "Pause orchestration outside Runs"
        }));
        assert!(actions.iter().any(|action| {
            action.keys == "- / + / u"
                && action.description == "Parallel 2 / Parallel 4 / Unchained"
        }));
        assert!(actions.iter().all(|action| {
            !action.keys.contains('h')
                && !action.description.contains("99")
                && !action.description.contains("100")
        }));

        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        for copy in [
            "Open New Run",
            "Pause or resume the selected run",
            "Pause orchestration outside Runs",
            "Parallel 2 / Parallel 4 / Unchained",
            "Close: h · Esc · Enter · q · F1",
        ] {
            assert!(rendered.contains(copy), "missing {copy}: {rendered}");
        }
        for secret in ["run-secret", "orchestration-secret", "019f"] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }

        model.orchestration_running = false;
        let actions = configured_runs_orchestration_help_actions(&model);
        assert!(actions.iter().any(|action| {
            action.keys == "Space" && action.description == "Resume orchestration outside Runs"
        }));
    }

    #[test]
    fn source_editor_footer_advertises_f1_instead_of_capturing_h() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.focus = Focus::Yaml;
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "source.yaml".into(),
            source_path: "/tmp/project/source.yaml".into(),
            draft_path: "/tmp/project/source.draft.yaml".into(),
            original: "value: true\n".to_owned(),
            text: "value: true\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        model.config.rebuild_projection();
        model
            .config
            .select_domain_index(ConfigDomain::Advanced.index());
        let backend = TestBackend::new(120, 28);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let footer = rendered_row(&terminal, 27);

        assert!(footer.contains("F1 help"), "{footer}");
        assert!(!footer.contains("h help"), "{footer}");
    }

    #[test]
    fn operate_footer_does_not_advertise_a_focus_key_claimed_by_the_profile() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active","run_type_id":"research"},
                "orchestration":{"running":true,"max_parallel":3},
                "views":[{
                    "id":"orchestration-controls",
                    "kind":"controls",
                    "options":{"keybindings":{"parallel_3":"3"}}
                }]
            }),
        );
        model.focus = Focus::Details;
        let backend = TestBackend::new(120, 28);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let footer = rendered_row(&terminal, 27);

        assert!(footer.contains("Details"), "{footer}");
        assert!(!footer.contains("3 Details"), "{footer}");
    }

    #[test]
    fn operate_surfaces_prefer_the_pinned_run_type_title_over_the_live_catalog() {
        let snapshot = json!({
            "run": {
                "id": "run-1",
                "goal": "Keep the original workflow identity",
                "status": "active",
                "run_type_id": "rt_7f3a9c",
                "run_type_title": "Original Research Sprint"
            },
            "graph": [],
            "tickets": []
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.run_types = vec![run_type(
            "rt_7f3a9c",
            "Renamed Live Catalog Entry",
            "The live definition changed after this run was planned.",
            1,
            "interactive",
            2,
        )];
        let backend = TestBackend::new(160, 42);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Original Research Sprint"), "{rendered}");
        let runs = operate_layout(Rect::new(0, 4, 160, 37)).runs;
        assert!(
            (runs.y..runs.bottom())
                .any(|row| rendered_row(&terminal, row).contains("Original Resea")),
            "{rendered}"
        );
        assert!(
            !rendered.contains("Renamed Live Catalog Entry"),
            "{rendered}"
        );
        assert!(!rendered.contains("rt_7f3a9c"), "{rendered}");
    }

    #[test]
    fn compact_terminal_guidance_uses_the_koni_brand() {
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        let backend = TestBackend::new(60, 10);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("Koni Control Center"), "{rendered}");
    }

    #[test]
    fn planning_header_shows_verified_live_activity_at_compact_and_roomy_sizes() {
        for (width, height) in [(82, 24), (150, 30)] {
            let mut model = ControlCenterModel::from_snapshot(
                "/tmp/project".into(),
                json!({
                    "run": {
                        "id": "run-private-019f",
                        "goal": "Plan it",
                        "status": "planning",
                        "run_type_title": "Large"
                    },
                    "orchestration": {"running": true, "max_parallel": 5},
                    "stages": [{
                        "status": "running",
                        "definition": {
                            "id": "architecture-private-019f",
                            "kind": "planning",
                            "title": "Plan architecture",
                            "required": true
                        }
                    }],
                    "agents": [{
                        "id": "planner-private-019f",
                        "stage_id": "architecture-private-019f",
                        "persona": "planner",
                        "status": "running"
                    }],
                    "tickets": [],
                    "graph": []
                }),
            );
            model.activity_tick = 2;
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let header = rendered_row(&terminal, 2);

            assert!(header.contains("Large · ⚙ Planning"), "{header}");
            assert!(header.contains("0/0 tickets · 0 new tks"), "{header}");
            assert!(!header.contains("Plan it"), "{header}");
            assert!(!header.contains("awaiting approval"), "{header}");
            for private_id in [
                "run-private-019f",
                "architecture-private-019f",
                "planner-private-019f",
            ] {
                assert!(!header.contains(private_id), "{header}");
            }
            let expected_activity_color = live_activity_style(&model).fg.unwrap();
            let activity_cells = terminal
                .backend()
                .buffer()
                .content()
                .iter()
                .filter(|cell| cell.symbol() == "⚙" && cell.fg == expected_activity_color)
                .count();
            assert!(
                activity_cells >= 2,
                "activity cogs were not live-styled: {header}"
            );
        }
    }

    #[test]
    fn planning_header_only_awaits_approval_after_durable_output_at_all_sizes() {
        for (width, height) in [(82, 24), (150, 30)] {
            let model = ControlCenterModel::from_snapshot(
                "/tmp/project".into(),
                json!({
                    "run": {
                        "id": "run-private-019f",
                        "goal": "Plan it",
                        "status": "planning",
                        "run_type_title": "Large"
                    },
                    "orchestration": {"running": true, "max_parallel": 5},
                    "stages": [{
                        "status": "succeeded",
                        "definition": {
                            "id": "architecture-private-019f",
                            "kind": "planning",
                            "title": "Plan architecture",
                            "required": true
                        },
                        "output": {"output": {"output": "Architecture contract body"}}
                    }],
                    "agents": [{
                        "id": "planner-private-019f",
                        "stage_id": "architecture-private-019f",
                        "persona": "planner",
                        "status": "completed"
                    }],
                    "tickets": [],
                    "graph": []
                }),
            );
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let header = rendered_row(&terminal, 2);

            assert!(header.contains("Large · ○ Planning"), "{header}");
            assert!(header.contains("◇ awaiting approval"), "{header}");
            assert!(!header.contains('⚙'), "{header}");
            for private_id in [
                "run-private-019f",
                "architecture-private-019f",
                "planner-private-019f",
            ] {
                assert!(!header.contains(private_id), "{header}");
            }
        }
    }

    #[test]
    fn planning_header_surfaces_pending_questions_instead_of_approval() {
        let model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run": {
                    "id": "run-private-019f",
                    "goal": "Clarify the contract",
                    "status": "planning",
                    "run_type_title": "Large"
                },
                "orchestration": {"running": true, "max_parallel": 5},
                "questions": [
                    {"id": "question-private-1", "status": "pending", "prompt": "Scope?"},
                    {"id": "question-private-2", "status": "pending", "prompt": "Inputs?"},
                    {"id": "question-private-3", "status": "pending", "prompt": "Errors?"}
                ],
                "stages": [{
                    "status": "awaiting_input",
                    "definition": {
                        "id": "architecture-private-019f",
                        "kind": "planning",
                        "title": "Plan architecture",
                        "required": true
                    }
                }],
                "agents": [{
                    "id": "planner-private-019f",
                    "stage_id": "architecture-private-019f",
                    "status": "awaiting_input"
                }],
                "tickets": [],
                "graph": []
            }),
        );
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let header = rendered_row(&terminal, 2);

        assert!(header.contains("? 3 awaiting input"), "{header}");
        assert!(header.contains("○ Planning"), "{header}");
        assert!(!header.contains("awaiting approval"), "{header}");
        assert!(!header.contains('⚙'), "{header}");
        for private_id in [
            "run-private-019f",
            "architecture-private-019f",
            "planner-private-019f",
            "question-private-1",
        ] {
            assert!(!header.contains(private_id), "{header}");
        }
    }

    #[test]
    fn roomy_header_omits_goal_and_orchestration_controls_but_keeps_run_telemetry() {
        let goal = "研究📓 notes across every workspace and preserve a deliberately long operator-facing objective without hiding control state";
        let model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run": {
                    "id": "run-1",
                    "goal": goal,
                    "status": "active",
                    "run_type_id": "large",
                    "run_type_title": "Large Research"
                },
                "orchestration": {"running": true, "max_parallel": 3, "unchained": false},
                "views": [{
                    "id": "orchestration-controls",
                    "kind": "controls",
                    "options": {"keybindings": {
                        "toggle": "space",
                        "parallel_2": "-",
                        "parallel_4": "+",
                        "unchained": "u"
                    }}
                }],
                "tickets": [
                    {"id": "closed", "status": "closed"},
                    {"id": "active", "status": "in_progress"}
                ],
                "graph": []
            }),
        );
        let backend = TestBackend::new(181, 30);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let header = rendered_row(&terminal, 2);

        assert!(header.contains("Large Research · ◐ Active"), "{header}");
        assert!(header.contains("· 1/2 tickets"), "{header}");
        assert!(header.contains("· 0 new tks"), "{header}");
        assert!(!header.contains(goal), "goal leaked into header: {header}");
        assert!(!header.contains("parallel"), "{header}");
        assert!(!header.contains("play/pause"), "{header}");
        assert_eq!(header.chars().count(), 181, "{header}");
        assert!(
            header.ends_with('│'),
            "right border was overwritten: {header}"
        );
    }

    #[test]
    fn compact_header_preserves_the_complete_planning_state_without_overflow() {
        let goal = "研究📓 a long planning goal that must yield space to durable run status";
        let model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run": {
                    "id": "run-1",
                    "goal": goal,
                    "status": "planning",
                    "run_type_id": "medium",
                    "run_type_title": "Medium"
                },
                "orchestration": {"running": true, "max_parallel": 5},
                "stages": [{
                    "status": "succeeded",
                    "definition": {
                        "id": "plan-private",
                        "kind": "planning",
                        "title": "Plan architecture",
                        "required": true
                    },
                    "output": {"output": "Plan body"}
                }],
                "tickets": [],
                "graph": []
            }),
        );
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let header = rendered_row(&terminal, 2);

        assert!(header.contains("Medium · ○ Planning"), "{header}");
        assert!(header.contains("· 0/0 tickets"), "{header}");
        assert!(header.contains("◇ awaiting approval"), "{header}");
        assert!(!header.contains(goal), "goal was not compacted: {header}");
        assert_eq!(header.chars().count(), 82, "{header}");
        assert!(
            header.ends_with('│'),
            "right border was overwritten: {header}"
        );
    }

    #[test]
    fn configure_layout_is_domain_first_and_excludes_the_run_graph() {
        let snapshot = json!({
            "run":{"id":"run-1","goal":"Build it","status":"active","profile_id":"default"},
            "graph":[{"id":"root","type":"task","title":"Root","edges":{}}],
            "tickets":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.toggle_mode();
        let backend = TestBackend::new(140, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        for domain in [
            "Project",
            "Run Types",
            "Agents",
            "Skills",
            "Workflows & Tickets",
            "Graph Model & Rules",
            "Actions & Checks",
            "Reports & Views",
            "Advanced",
        ] {
            assert!(rendered.contains(domain), "missing {domain}: {rendered}");
        }
        assert!(rendered.contains("Configuration"), "{rendered}");
        assert!(rendered.contains("Future runs only"), "{rendered}");
        assert!(rendered.contains("Guided editor"), "{rendered}");
        assert!(!rendered.contains("Project graph"), "{rendered}");
        assert!(!rendered.contains("[task]"), "{rendered}");
    }

    #[test]
    fn control_tips_are_anchored_to_surface_footers() {
        let size = ratatui::layout::Size::new(120, 30);
        let screen = Rect::new(0, 0, size.width, size.height);

        let mut modal_model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        modal_model.dialog = Some(Dialog::NewConfigDocument(
            crate::model::NewConfigDocumentDraft {
                relative_path: "run-types/custom.yaml".to_owned(),
            },
        ));
        let backend = TestBackend::new(size.width, size.height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &modal_model)).unwrap();
        let modal = centered_box(76, 16, screen);
        let (_, controls_y) = rendered_cell_position(&terminal, "Enter create draft")
            .expect("new-document controls should render");
        let (_, explanation_y) = rendered_cell_position(&terminal, "The document is published")
            .expect("new-document explanation should render");
        assert_eq!(controls_y, modal.bottom() - 1);
        assert!(explanation_y < controls_y);

        let mut runs_model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        runs_model.runs.clear();
        terminal.draw(|frame| draw(frame, &runs_model)).unwrap();
        let operate = operate_layout(Rect::new(0, 4, size.width, size.height - 5));
        let runs_title = rendered_row(&terminal, operate.runs.y);
        let runs_footer = rendered_row(&terminal, operate.runs.bottom() - 2);
        assert!(!runs_title.contains("n new"), "{runs_title}");
        assert!(runs_footer.contains("n New run"), "{runs_footer}");

        let mut configure_model = runs_model;
        configure_model.mode = Mode::Configure;
        terminal
            .draw(|frame| draw(frame, &configure_model))
            .unwrap();
        let configure = configure_layout(Rect::new(0, 4, size.width, size.height - 5));
        assert_eq!(configure.draft_bar.unwrap().bottom(), size.height - 1);
        assert!(rendered_row(&terminal, configure.draft_bar.unwrap().y + 1).contains("t run type"));
    }

    #[test]
    fn compact_configure_keeps_every_domain_and_all_three_columns_visible() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        let backend = TestBackend::new(82, 20);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        for label in [
            "Project",
            "Run Types",
            "Agents",
            "Skills",
            "Workflows & Tickets",
            "Graph Model & Rules",
            "Actions & Checks",
            "Reports & Views",
            "Advanced",
            "Domains",
            "Resources",
            "Guided editor",
        ] {
            assert!(rendered.contains(label), "missing {label}: {rendered}");
        }
        assert!(!rendered.contains("Project graph"), "{rendered}");
    }

    #[test]
    fn compact_configure_budgets_agent_identity_capabilities_and_publish_controls() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.status = "A deliberately long status must yield to configuration controls".to_owned();
        model.config.documents = vec![
            config_document(
                ".codex/agents/architecture-mapper.toml",
                r#"name = "architecture-mapper"
description = "Maps application architecture before implementation."
developer_instructions = "Map the smallest relevant repository slice."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
"#,
            ),
            config_document(
                ".codex/agents/change-designer.toml",
                r#"name = "change-designer"
description = "Designs a bounded implementation change."
developer_instructions = "Design the smallest coherent change."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
"#,
            ),
        ];
        model.config.rebuild_projection();
        model
            .config
            .select_domain_index(ConfigDomain::Agents.index());
        model.focus = Focus::ConfigForm;
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        let content = Rect::new(0, 4, 82, 19);
        let editor = configure_layout(content).editor;
        let editor_inner_width = usize::from(editor.width.saturating_sub(2));
        let header_height =
            guided_editor_header_height(&model, ConfigDomain::Agents, editor_inner_width);

        assert!(rendered.contains("Ctrl-P publish"), "{rendered}");
        assert!(rendered.contains("Ctrl-D discard"), "{rendered}");
        assert!(rendered.contains("Reasoning"), "{rendered}");
        assert!(rendered.contains("Workers · Arch"), "{rendered}");
        assert!(rendered.contains("Workers · Chan"), "{rendered}");
        assert!(
            rendered.contains('…'),
            "compact identities need an explicit ellipsis: {rendered}"
        );
        assert!(!rendered.contains("published"), "{rendered}");
        assert!(!rendered.contains('✓'), "{rendered}");
        assert_eq!(header_height, 7);
        assert_eq!(
            configure_field_at(&model, editor.x + 1, editor.y + 1 + header_height, content,),
            Some(0)
        );

        model.config.documents[0]
            .text
            .push_str("# unpublished operator change\n");
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let dirty = rendered_text(&terminal);
        assert!(dirty.contains("unpublished"), "{dirty}");
        assert!(dirty.contains("publish or discard"), "{dirty}");
        assert!(dirty.contains("Ctrl-D discard"), "{dirty}");
    }

    #[test]
    fn compact_truncation_respects_unicode_display_width() {
        let compact = short_display_width("研究📓 Architecture mapper", 12);

        assert!(compact.ends_with('…'));
        assert!(UnicodeWidthStr::width(compact.as_str()) <= 12);
    }

    #[test]
    fn configure_resources_are_semantic_and_advanced_owns_raw_sources() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.config.documents = vec![
            config_document(
                "project.yaml",
                r#"schema_version: "1.0"
project: {id: notes, title: Notes}
default_run_type: medium
run_types:
  - {id: medium, path: run-types/medium.yaml}
"#,
            ),
            config_document(
                "run-types/medium.yaml",
                r#"schema_version: "1.0"
id: medium
title: Medium
profile: {source: .codex/koni/profile.yaml}
intake: {fields: {}, order: []}
pipeline: {stages: {}, order: []}
questions: {policy: high_impact_only, default_scope: run}
git: {branch_template: runs/example, ticket_branch_template: tickets/example}
run_card: {sections: [goal]}
agents:
  roles:
    planner: {model: planning-model, reasoning_effort: high}
    lead: {model: lead-model, reasoning_effort: high}
    ticket_worker: {model: worker-model, reasoning_effort: medium}
    reviewer: {model: review-model, reasoning_effort: high}
"#,
            ),
        ];
        model.config.rebuild_projection();
        model
            .config
            .select_domain_index(ConfigDomain::RunTypes.index());
        let medium = model
            .config
            .domain_resources()
            .position(|resource| resource.title == "Medium")
            .unwrap();
        model.config.select_resource_index(medium);
        model.focus = Focus::Yaml;
        let backend = TestBackend::new(150, 36);
        let mut terminal = Terminal::new(backend).unwrap();

        let content = Rect::new(0, 4, 150, 31);
        let layout = configure_layout(content);
        assert_eq!(
            configure_domain_at(
                &model,
                layout.domains.x + 1,
                layout.domains.y + 1 + ConfigDomain::RunTypes.index() as u16,
                content,
            ),
            Some(ConfigDomain::RunTypes.index())
        );
        let resource_count = model.config.domain_resource_count();
        let (first_resource, _) =
            configure_resource_window(&model, layout.resources, resource_count);
        assert_eq!(
            configure_resource_at(
                &model,
                layout.resources.x + 1,
                layout.resources.y
                    + 1
                    + u16::try_from(medium - first_resource).unwrap() * CONFIG_RESOURCE_CARD_HEIGHT,
                content,
            ),
            Some(medium)
        );
        let field_y = layout.editor.y + 1 + 4;
        assert!(
            configure_field_at(&model, layout.editor.x + 1, field_y, content).is_some(),
            "guided field hit testing did not share the rendered geometry"
        );

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let run_types = rendered_text(&terminal);
        assert!(run_types.contains("Run Types Resources"), "{run_types}");
        assert!(run_types.contains("Medium"), "{run_types}");
        assert!(
            run_types.contains("Run behavior, intake, and planning questions"),
            "{run_types}"
        );
        assert!(run_types.contains("Guided editor"), "{run_types}");
        assert!(!run_types.contains("run-types/medium.yaml"), "{run_types}");
        assert!(!run_types.contains("Project graph"), "{run_types}");

        model
            .config
            .select_domain_index(ConfigDomain::Agents.index());
        model.focus = Focus::ConfigForm;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let agents = rendered_text(&terminal);
        assert!(agents.contains("No resources in this domain"), "{agents}");
        assert!(!agents.contains("Run type defaults"), "{agents}");

        model
            .config
            .select_domain_index(ConfigDomain::Advanced.index());
        let medium_source = model
            .config
            .domain_resources()
            .position(|resource| resource.document_path.ends_with("run-types/medium.yaml"))
            .unwrap();
        model.config.select_resource_index(medium_source);
        model.focus = Focus::Yaml;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let advanced = rendered_text(&terminal);
        assert!(advanced.contains("Advanced source"), "{advanced}");
        assert!(advanced.contains("run-types/medium.yaml"), "{advanced}");
        assert!(advanced.contains("schema_version"), "{advanced}");
        assert!(!advanced.contains("Project graph"), "{advanced}");
    }

    #[test]
    fn native_agent_card_joins_explicit_prompt_without_paths_or_duplicate_instructions() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.config.documents = vec![
            config_document(
                ".codex/agents/reviewer.toml",
                "name = \"reviewer\"\ndescription = \"Review changes\"\ndeveloper_instructions = \"Review carefully.\"\nmodel = \"gpt-5.6-terra\"\nmodel_reasoning_effort = \"high\"\n",
            ),
            config_document(
                "personas.yaml",
                "personas:\n  - id: reviewer\n    codex_agent: reviewer\n    prompt: prompts/reviewer.md\n    model_role: reviewer\n    sandbox: {mode: workspace-write, network_access: false}\n",
            ),
            config_document(
                "prompts/reviewer.md",
                "# Reviewer\n\nReview the exact bounded change.\n",
            ),
        ];
        model.config.rebuild_projection();
        model.config.select_resource_for(
            ConfigDomain::Agents,
            Path::new(".codex/agents/reviewer.toml"),
            crate::configure::ConfigResourceKind::NativeAgent,
        );
        let resource = model.config.selected_resource().cloned().unwrap();

        assert!(model.config.form_rows.iter().any(|row| {
            row.document_path == Path::new("personas.yaml") && row.path.ends_with("sandbox.mode")
        }));
        assert_eq!(
            model
                .config
                .form_rows
                .iter()
                .filter(|row| row.path.ends_with(".instructions"))
                .count(),
            1
        );
        assert!(
            !model
                .config
                .form_rows
                .iter()
                .any(|row| row.path.ends_with(".developer_instructions")
                    || row.path.ends_with(".prompt"))
        );

        model.focus = Focus::Yaml;
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let card = rendered_text(&terminal);
        for field in ["Description", "Instructions", "Model", "Reasoning"] {
            assert!(card.contains(field), "missing {field}: {card}");
        }
        assert!(!card.contains("prompts/reviewer.md"), "{card}");

        model.config.selected_form_row = model
            .config
            .form_rows
            .iter()
            .position(|row| row.edit_kind == crate::model::FormRowEditKind::LinkedMarkdown)
            .unwrap();
        model.open_form_editor();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let editor = rendered_text(&terminal);
        assert!(editor.contains("Agent instructions"), "{editor}");
        assert!(editor.contains("Reviewer"), "{editor}");
        assert!(editor.contains("MARKDOWN"), "{editor}");
        assert!(!editor.contains("prompts/reviewer.md"), "{editor}");

        assert_eq!(config_resource_state(&model, &resource).1, "");
        model
            .config
            .documents
            .iter_mut()
            .find(|document| document.relative_path == Path::new("prompts/reviewer.md"))
            .unwrap()
            .text
            .push_str("Check current proof.\n");
        assert_eq!(
            config_resource_state(&model, &resource).1,
            "publish or discard"
        );
    }

    #[test]
    fn shared_config_files_mark_only_the_semantic_resource_that_changed() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.config.documents = vec![
            config_document(
                "profile.yaml",
                "schema_version: '1.0'\nimports:\n  graph: [graph.yaml]\n",
            ),
            config_document(
                "graph.yaml",
                "node_types:\n  - id: first\n    description: First node\n    stage: framing\n    statuses: [active]\n  - id: second\n    description: Second node\n    stage: assurance\n    statuses: [active]\n",
            ),
        ];
        model.config.rebuild_projection();
        let resources = model
            .config
            .resources
            .iter()
            .filter(|resource| {
                resource.domain == ConfigDomain::GraphRules
                    && resource.kind == crate::configure::ConfigResourceKind::NodeType
            })
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(resources.len(), 2);

        let graph = model
            .config
            .documents
            .iter_mut()
            .find(|document| document.relative_path == Path::new("graph.yaml"))
            .unwrap();
        graph.text = graph.text.replacen("stage: framing", "stage: design", 1);

        assert_eq!(
            config_resource_state(&model, &resources[0]).1,
            "publish or discard"
        );
        assert_eq!(config_resource_state(&model, &resources[1]).1, "");
    }

    #[test]
    fn guided_scalar_dialog_uses_friendly_labels_instead_of_yaml_locators() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.dialog = Some(Dialog::EditScalar(crate::model::EditScalarDraft {
            document_path: "run-types/medium.yaml".into(),
            path: "$.agents.roles.planner.model".to_owned(),
            value: "planning-model".to_owned(),
            kind: "string".to_owned(),
            cursor: "planning-model".chars().count(),
            locator: vec![
                crate::model::FormPathToken::Key("agents".to_owned()),
                crate::model::FormPathToken::Key("roles".to_owned()),
                crate::model::FormPathToken::Key("planner".to_owned()),
                crate::model::FormPathToken::Key("model".to_owned()),
            ],
        }));
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("Edit Model"), "{rendered}");
        assert!(rendered.contains("Roles › Planner"), "{rendered}");
        assert!(!rendered.contains("$.agents.roles"), "{rendered}");
        assert!(!rendered.contains("run-types/medium.yaml"), "{rendered}");
    }

    #[test]
    fn scalar_dialog_wraps_the_complete_value_at_compact_and_roomy_sizes() {
        let value = "Inspect every compiler-owned ticket against its acceptance contract, verify receipts before approval, preserve unrelated project changes, and report concrete failures with actionable remediation. Re-check the final diff and explain any residual risk before declaring the work complete.";
        for (width, height) in [(82, 24), (140, 40)] {
            let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
            model.mode = Mode::Configure;
            model.dialog = Some(Dialog::EditScalar(crate::model::EditScalarDraft {
                document_path: "private/run-019f-secret/agent.toml".into(),
                path: "$.agents.reviewer.developer_instructions".to_owned(),
                value: value.to_owned(),
                kind: "string".to_owned(),
                cursor: 47,
                locator: vec![crate::model::FormPathToken::Key(
                    "019f-private-locator".to_owned(),
                )],
            }));
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();

            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let Dialog::EditScalar(edit) = model.dialog.as_ref().unwrap() else {
                unreachable!();
            };
            let area = edit_scalar_dialog_area(Rect::new(0, 0, width, height), edit, None);
            let buffer = terminal.backend().buffer();
            let mut rendered_value = String::new();
            let mut value_rows = std::collections::BTreeSet::new();
            let mut carets = 0;
            for row in area.y..area.bottom() {
                for column in area.x..area.right() {
                    let cell = buffer.cell((column, row)).unwrap();
                    if cell.fg == Color::LightGreen && cell.bg == Color::DarkGray {
                        rendered_value.push_str(cell.symbol());
                        value_rows.insert(row);
                    }
                    if cell.symbol() == "▏" && cell.bg == Color::Cyan {
                        carets += 1;
                    }
                }
            }
            let without_whitespace = |text: &str| {
                text.chars()
                    .filter(|character| !character.is_whitespace())
                    .collect::<String>()
            };
            assert_eq!(
                without_whitespace(&rendered_value),
                without_whitespace(value)
            );
            assert!(
                value_rows.len() > 1,
                "value did not wrap at {width}×{height}"
            );
            assert_eq!(carets, 1, "missing visible caret at {width}×{height}");
            assert_eq!(buffer.cell((area.x, area.y)).unwrap().symbol(), "┌");
            assert_eq!(
                buffer.cell((area.right() - 1, area.y)).unwrap().symbol(),
                "┐"
            );
            assert_eq!(
                buffer.cell((area.x, area.bottom() - 1)).unwrap().symbol(),
                "└"
            );
            assert_eq!(
                buffer
                    .cell((area.right() - 1, area.bottom() - 1))
                    .unwrap()
                    .symbol(),
                "┘"
            );
            for row in area.y + 1..area.bottom() - 1 {
                assert_eq!(buffer.cell((area.x, row)).unwrap().symbol(), "│");
                assert_eq!(buffer.cell((area.right() - 1, row)).unwrap().symbol(), "│");
            }
            let rendered = rendered_text(&terminal);
            assert!(rendered.contains("type/paste"), "{rendered}");
            assert!(rendered.contains("Enter apply"), "{rendered}");
            assert!(!rendered.contains("019f-secret"), "{rendered}");
            assert!(!rendered.contains("019f-private-locator"), "{rendered}");
        }
    }

    #[test]
    fn operate_view_is_id_free_and_uses_authoritative_workflow_glyphs() {
        let snapshot = json!({
            "run": {
                "id": "019f4fb9-18df-7592-bf8f-c1ee2258546a",
                "goal": "Evaluate whether scaling improves the classifier",
                "status": "active",
                "profile_id": "research",
                "profile_hash": "sha256:secret"
            },
            "board": {
                "ticket_workflows": {
                    "TK-e2e1f858917e64c0": {
                        "completed_steps": ["formulate"],
                        "ready_steps": [],
                        "pending_steps": ["evaluate"],
                        "active_worker_step": "evaluate",
                        "worker_state": "running"
                    }
                }
            },
            "views": [{
                "id": "research-tickets",
                "kind": "tabbed_table",
                "options": {
                    "show_raw_ids": false,
                    "agent_active_glyph": "⚙",
                    "step_glyphs": {"done": "●", "active": "◐", "pending": "○"}
                }
            }],
            "graph": [{
                "id": "019f4fb9-18e1-70a2-8143-6aeb41d59537",
                "type": "hypothesis",
                "title": "Scaling helps KNN",
                "edges": {}
            }],
            "tickets": [{
                "id": "TK-e2e1f858917e64c0",
                "title": "test-hypothesis: Evaluate scaling",
                "status": "in_progress",
                "operation": "test-hypothesis",
                "scope": {
                    "read_nodes": ["019f4fb9-18e1-70a2-8143-6aeb41d59537"],
                    "write_nodes": ["019f4fb9-18e1-70a2-8143-6aeb41d59537"],
                    "read_paths": [], "write_paths": []
                },
                "workflow": [
                    {"id":"formulate", "persona":"hypothesis-planner", "expected_outputs":["a claim"]},
                    {"id":"evaluate", "persona":"experiment-runner", "expected_outputs":["validated evidence"]}
                ],
                "outputs": [{"step_id":"formulate", "receipts":["019f4fbe-c79d-75c2-a25c-68b417f822a0"]}],
                "blockers": [],
                "lease": {
                    "branch":"koni/ticket/TK-e2e1f858917e64c0",
                    "worktree":"/tmp/worktrees/TK-e2e1f858917e64c0",
                    "worker_pid":81948
                }
            }]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(160, 42);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("Evaluate scaling"), "{rendered}");
        assert!(rendered.contains("●─◐"), "{rendered}");
        assert!(rendered.contains("Experiment runner"), "{rendered}");
        assert!(rendered.contains("Scaling helps KNN"), "{rendered}");
        for internal in ["TK-e2e1", "019f4fb9", "sha256:", "/worktrees/", "81948"] {
            assert!(
                !rendered.contains(internal),
                "leaked {internal}: {rendered}"
            );
        }
    }

    #[test]
    fn closed_ticket_suppresses_stale_worker_without_faking_workflow_receipts() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Finish it","status":"active","profile_id":"default"},
            "board":{"ticket_workflows":{"TK-secret":{
                "completed_steps":[],
                "ready_steps":[],
                "pending_steps":["build","review"],
                "active_worker_step":"build",
                "worker_state":"running"
            }}},
            "tickets":[{
                "id":"TK-secret",
                "title":"Closed work",
                "status":"closed",
                "operation":"build",
                "workflow":[
                    {"id":"build","persona":"builder"},
                    {"id":"review","persona":"reviewer"}
                ],
                "outputs":[],
                "blockers":[],
                "lease":{"worker_pid":99999}
            }],
            "graph":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.ticket_tab = crate::model::TicketTab::All;
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("○─○"), "{rendered}");
        assert!(!rendered.contains("Working now"), "{rendered}");
        assert!(!rendered.contains("TK-secret"), "{rendered}");
        assert!(!rendered.contains("99999"), "{rendered}");
    }

    #[test]
    fn cancelled_and_superseded_tickets_do_not_synthesize_completed_steps() {
        for status in ["cancelled", "superseded"] {
            let ticket = json!({
                "id":"ticket",
                "status":status,
                "workflow":[
                    {"id":"build","persona":"builder","expected_output":"built product"},
                    {"id":"review","persona":"reviewer","expected_output":"passed review"}
                ],
                "outputs":[]
            });

            let progress = ticket_progress(&ticket, None);

            assert_eq!(progress.done, 0, "{status} ticket looked complete");
            assert!(
                progress
                    .states
                    .iter()
                    .all(|state| *state == StepVisualState::Pending),
                "{status} ticket synthesized workflow state: {:?}",
                progress.states
            );
        }
    }

    #[test]
    fn workflow_uses_compiler_completion_and_review_truth() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Trust the board","status":"active","profile_id":"default"},
            "board":{"ticket_workflows":{"ticket":{
                "completed_steps":[],
                "ready_steps":["build"],
                "pending_steps":["build"],
                "active_worker_step":null,
                "worker_state":"idle",
                "review_status":"passed"
            }}},
            "tickets":[{
                "id":"ticket",
                "title":"Receipt-aware progress",
                "status":"in_progress",
                "operation":"build",
                "workflow":[
                    {"id":"build","kind":"action","persona":"builder"},
                    {"id":"review","kind":"review","persona":"reviewer"}
                ],
                "outputs":[{"step_id":"build","typed":{"note":"artifact without receipt"}}],
                "blockers":[]
            }],
            "graph":[]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("○─●"), "{rendered}");
    }

    #[test]
    fn planning_timeline_groups_stage_events_and_hides_command_noise() {
        let text = planning_timeline(
            &[
                json!({
                    "type":"planning.intake",
                    "at":"2026-07-13T09:14:30Z"
                }),
                json!({
                    "type":"planning.agent.starting",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:32Z"
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"item.started","item":{
                        "type":"reasoning",
                        "summary":[]
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"item.completed","item":{
                        "type":"reasoning",
                        "summary":[{"text":"Mapped the storage boundary"}]
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"token.usage.updated","usage":{
                        "total_tokens":12000
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"item.started","item":{
                        "type":"command_execution",
                        "command":"/bin/zsh -lc \"git status --short\""
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"item.completed","item":{
                        "type":"command_execution",
                        "exit_code":1
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:33Z",
                    "event":{"type":"item.completed","item":{
                        "type":"command_execution",
                        "exit_code":1
                    }}
                }),
                json!({
                    "type":"planning.agent.event",
                    "stage_id":"architecture-plan",
                    "at":"2026-07-13T09:14:34Z",
                    "event":{"type":"item.completed","item":{
                        "type":"agent_message",
                        "text":"{\"questions\":[{\"prompt\":\"Which storage boundary should notes use?\"}]}"
                    }}
                }),
                json!({
                    "type":"planning.question.opened",
                    "request":{"prompt":"This durable question must not become history UI"}
                }),
            ],
            &[json!({
                "definition":{
                    "id":"architecture-plan",
                    "title":"Plan architecture"
                }
            })],
            72,
        );
        let rendered = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("Run setup"), "{rendered}");
        assert!(
            rendered.contains("  09:14:30  Captured objective"),
            "{rendered}"
        );
        assert!(rendered.contains("Plan architecture"), "{rendered}");
        assert!(
            rendered.contains("  09:14:32  Started planning pass"),
            "{rendered}"
        );
        assert!(
            rendered.contains("  09:14:34  Planning paused"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Reasoned — Mapped the storage"),
            "{rendered}"
        );
        assert!(
            rendered.contains("project inspection command failed (exit 1) ×2"),
            "{rendered}"
        );
        assert!(rendered.contains("Planning paused for input"), "{rendered}");
        assert!(!rendered.contains("Inspecting the project"), "{rendered}");
        assert!(!rendered.contains("git status --short"), "{rendered}");
        assert!(!rendered.contains('●'), "{rendered}");
        assert!(!rendered.contains("Which storage boundary"), "{rendered}");
        assert!(!rendered.contains("durable question"), "{rendered}");
        assert!(!rendered.contains("Planning agent event"), "{rendered}");
        assert!(!rendered.contains("Token usage updated"), "{rendered}");
        assert!(!rendered.contains("  Reasoning"), "{rendered}");
    }

    #[test]
    fn recent_activity_combines_colored_graph_edits_with_compiler_work() {
        let run = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active","profile_id":"research"},
            "graph":[
                {"id":"claim-1","type":"claim","title":"Stable adjacency claim","edges":{}},
                {"id":"experiment-1","type":"experiment","title":"Sortedness runtime probe","edges":{}}
            ],
            "tickets":[{
                "id":"ticket-secret",
                "title":"Prepare bounded experiment",
                "status":"in_progress",
                "workflow":[],
                "outputs":[{
                    "step_id":"design",
                    "recorded_at":"2026-07-13T03:00:01Z",
                    "typed":{"graph_delta":{
                        "add_nodes":[{"id":"claim-2","type":"claim","title":"Boundary cases hold","edges":{}}],
                        "upsert":[{"id":"experiment-1","type":"experiment","title":"Sortedness runtime probe","edges":{}}],
                        "delete":["claim-1"]
                    }}
                }]
            }],
            "events":[{
                "type":"compiler.compile.scoped",
                "at":"2026-07-13T03:00:02Z",
                "ticket_id":"ticket-secret",
                "data":{"graph_hash":"sha256:hidden"}
            },{
                "type":"compiler.recovery.required",
                "at":"2026-07-13T03:00:04Z",
                "ticket_id":"ticket-secret"
            },{
                "type":"compiler.recovery.required",
                "at":"2026-07-13T03:00:03Z",
                "ticket_id":"ticket-secret"
            }]
        }));
        let items = recent_activity_items(&run);

        assert!(items.iter().any(|item| {
            item.tone == ActivityTone::Added && item.text == "Added Claim: Boundary cases hold"
        }));
        assert!(items.iter().any(|item| {
            item.tone == ActivityTone::Modified
                && item.text == "Modified Experiment: Sortedness runtime probe"
        }));
        assert!(items.iter().any(|item| {
            item.tone == ActivityTone::Deleted
                && item.text == "Deleted Claim: Stable adjacency claim"
        }));
        assert!(items.iter().any(|item| {
            item.tone == ActivityTone::Compiler
                && item.text == "Compiled ticket: Prepare bounded experiment"
        }));
        assert!(items.iter().any(|item| {
            item.tone == ActivityTone::Compiler
                && item.text == "Recovery needed: Prepare bounded experiment"
                && item.count == 2
        }));
        let rendered = items
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!rendered.contains("ticket-secret"), "{rendered}");
        assert!(!rendered.contains("sha256"), "{rendered}");
    }

    #[test]
    fn recent_activity_shows_row_timestamps_and_only_active_runtime_in_its_header() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Observe it","status":"active","profile_id":"software"},
                "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
                "lifecycle":{"running":true,"active_runtime_milliseconds":3_723_000},
                "events":[{
                    "type":"compiler.compile.full",
                    "at":"2026-07-13T03:04:05Z"
                }]
            }),
        );
        model.focus = Focus::Activity;
        let backend = TestBackend::new(72, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw_recent_activity(frame, &model, frame.area()))
            .unwrap();
        let rendered = rendered_text(&terminal);

        assert!(
            rendered.contains("Recent activity · 1h 02m active"),
            "{rendered}"
        );
        assert!(
            rendered.contains("03:04:05  ◇ Recompiled project graph"),
            "{rendered}"
        );
        assert!(!rendered.contains("1–1"), "{rendered}");
        assert!(!rendered.contains("· 1 "), "{rendered}");
    }

    #[test]
    fn compact_dashboard_adapts_recent_activity_title_without_clipping_runtime() {
        fn model(milliseconds: u64) -> ControlCenterModel {
            ControlCenterModel::from_snapshot(
                "/tmp/project".into(),
                json!({
                    "run":{"id":"run","goal":"Observe it","status":"active","profile_id":"software"},
                    "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
                    "lifecycle":{"running":true,"active_runtime_milliseconds":milliseconds},
                    "events":[{"type":"compiler.compile.full","at":"2026-07-13T03:04:05Z"}]
                }),
            )
        }

        fn draw_dashboard(model: &ControlCenterModel, width: u16) -> (Terminal<TestBackend>, Rect) {
            let backend = TestBackend::new(width, 24);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| draw(frame, model)).unwrap();
            let activity = operate_layout(Rect::new(0, 4, width, 19)).activity;
            (terminal, activity)
        }

        fn panel_top(terminal: &Terminal<TestBackend>, area: Rect) -> String {
            (area.x..area.right())
                .filter_map(|column| terminal.backend().buffer().cell((column, area.y)))
                .map(|cell| cell.symbol())
                .collect()
        }

        fn expected_panel_top(title: &str, width: u16) -> String {
            let fill = usize::from(width)
                .saturating_sub(2)
                .saturating_sub(UnicodeWidthStr::width(title));
            format!("┌{title}{}┐", "─".repeat(fill))
        }

        let elapsed = model(3_723_000);
        let (compact, compact_activity) = draw_dashboard(&elapsed, 82);
        assert_eq!(compact_activity.width, 27);
        assert_eq!(
            panel_top(&compact, compact_activity),
            expected_panel_top(" Activity · 1h02m ", compact_activity.width)
        );

        let (roomy, roomy_activity) = draw_dashboard(&elapsed, 105);
        assert_eq!(
            panel_top(&roomy, roomy_activity),
            expected_panel_top(" Recent activity · 1h 02m active ", roomy_activity.width)
        );

        let (zero, zero_activity) = draw_dashboard(&model(0), 82);
        assert_eq!(
            panel_top(&zero, zero_activity),
            expected_panel_top(" Activity · 0s ", zero_activity.width)
        );

        let (extreme, extreme_activity) = draw_dashboard(&model(u64::MAX), 82);
        assert_eq!(
            panel_top(&extreme, extreme_activity),
            expected_panel_top(" Activity ", extreme_activity.width)
        );
    }

    #[test]
    fn active_runtime_requires_a_durable_approval_anchor_and_explicit_duration() {
        assert_eq!(active_runtime_label(None), None);

        let no_anchor = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active"},
            "lifecycle":{"active_runtime_milliseconds":3_723_000}
        }));
        assert_eq!(active_runtime_label(Some(&no_anchor)), None);

        let missing_duration = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active"},
            "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
            "lifecycle":{}
        }));
        assert_eq!(active_runtime_label(Some(&missing_duration)), None);

        let malformed_anchor = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active"},
            "orchestration":{"active_runtime_approved_at":"not-a-timestamp"},
            "lifecycle":{"active_runtime_milliseconds":3_723_000}
        }));
        assert_eq!(active_runtime_label(Some(&malformed_anchor)), None);

        let planning = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"planning"},
            "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
            "lifecycle":{"active_runtime_milliseconds":3_723_000}
        }));
        assert_eq!(active_runtime_label(Some(&planning)), None);

        let approved_zero = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active"},
            "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
            "lifecycle":{"active_runtime_milliseconds":0}
        }));
        assert_eq!(
            active_runtime_label(Some(&approved_zero)).as_deref(),
            Some("0s active")
        );

        let approved_elapsed = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Observe it","status":"active"},
            "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
            "lifecycle":{"active_runtime_milliseconds":3_723_000}
        }));
        assert_eq!(
            active_runtime_label(Some(&approved_elapsed)).as_deref(),
            Some("1h 02m active")
        );
    }

    #[test]
    fn recent_activity_omits_unanchored_runtime_but_preserves_approved_zero() {
        let mut no_run = ControlCenterModel::from_snapshot("/tmp/project".into(), json!({}));
        no_run.runs.clear();
        let backend = TestBackend::new(72, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw_recent_activity(frame, &no_run, frame.area()))
            .unwrap();
        let rendered = rendered_text(&terminal);
        assert!(
            rendered.contains("Select a run to inspect activity"),
            "{rendered}"
        );
        assert!(!rendered.contains(" active"), "{rendered}");

        let planning = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Plan it","status":"planning"},
                "lifecycle":{"active_runtime_milliseconds":0}
            }),
        );
        terminal
            .draw(|frame| draw_recent_activity(frame, &planning, frame.area()))
            .unwrap();
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("Recent activity"), "{rendered}");
        assert!(!rendered.contains("0s active"), "{rendered}");

        let approved = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run","goal":"Run it","status":"active"},
                "orchestration":{"active_runtime_approved_at":"2026-07-14T20:00:00Z"},
                "lifecycle":{"active_runtime_milliseconds":0}
            }),
        );
        terminal
            .draw(|frame| draw_recent_activity(frame, &approved, frame.area()))
            .unwrap();
        let rendered = rendered_text(&terminal);
        assert!(
            rendered.contains("Recent activity · 0s active"),
            "{rendered}"
        );
    }

    #[test]
    fn ticket_overview_keeps_live_status_near_title_and_summarizes_completed_steps() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Build it","status":"active","profile_id":"software"},
            "board":{"ticket_workflows":{"ticket":{
                "completed_steps":["build"],
                "ready_steps":["review"],
                "pending_steps":["review"],
                "active_worker_step":"review",
                "worker_state":"running"
            }}},
            "tickets":[{
                "id":"ticket",
                "title":"Implement note storage",
                "status":"in_progress",
                "operation":"build",
                "workflow":[
                    {"id":"build","persona":"builder","expected_output":"implemented note persistence"},
                    {"id":"review","kind":"review","persona":"reviewer","expected_output":"review receipt"}
                ],
                "outputs":[{
                    "step_id":"build",
                    "persona":"builder",
                    "typed":{"summary":"Implemented durable note storage"}
                }],
                "blockers":[],
                "lease":{}
            }],
            "events":[{"type":"compiler.output.recorded","ticket_id":"ticket"}],
            "agents":[{"ticket_id":"ticket","stage_id":"review","persona":"reviewer","status":"running"}]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let ticket = model.selected_ticket_value().unwrap();
        let text = metadata_text(ticket, model.selected_run_data(), &model, 80)
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines[0], "Implement note storage");
        assert!(lines[1].contains("In progress"), "{text}");
        assert!(lines[2].contains("Working now · Reviewer"), "{text}");
        assert!(text.contains("Build  ·  Builder"), "{text}");
        assert!(!text.contains("Build  done"), "{text}");
        assert!(text.contains("Review  working  ·  Reviewer"), "{text}");
        assert!(text.contains("Implemented durable note storage"), "{text}");
        assert!(!text.contains("Recent activity"), "{text}");

        let compact = metadata_text(ticket, model.selected_run_data(), &model, 24);
        let build_row = compact
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .find(|line| line.contains("Builder"))
            .expect("compact details retain the completed step row");
        assert!(build_row.contains("Build · Builder"), "{build_row}");
        assert!(!build_row.contains("done"), "{build_row}");
        assert!(build_row.chars().count() <= 24, "{build_row}");
        assert_eq!(compact_step_persona("change-designer"), "Designer");
        assert_eq!(compact_step_persona("risk-analyst"), "Risk");
    }

    #[test]
    fn completed_step_without_recorded_outcome_does_not_claim_its_expectation() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Build it","status":"active","profile_id":"software"},
            "board":{"ticket_workflows":{"ticket":{
                "completed_steps":["build"],
                "ready_steps":[],
                "pending_steps":[],
                "worker_state":"idle"
            }}},
            "tickets":[{
                "id":"ticket",
                "title":"Implement note storage",
                "status":"closed",
                "operation":"build",
                "workflow":[{
                    "id":"build",
                    "persona":"builder",
                    "expected_output":"implemented note persistence"
                }],
                "outputs":[{"step_id":"build"}],
                "blockers":[]
            }]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.ticket_tab = crate::model::TicketTab::All;
        let ticket = model.selected_ticket_value().unwrap();
        let details = metadata_text(ticket, model.selected_run_data(), &model, 80);
        let rendered = details
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            rendered.contains("No outcome summary recorded"),
            "{rendered}"
        );
        assert!(
            !rendered.contains("Produced implemented note"),
            "{rendered}"
        );
        let missing = details
            .lines
            .iter()
            .find(|line| {
                line.spans
                    .iter()
                    .any(|span| span.content.contains("No outcome summary recorded"))
            })
            .expect("missing outcome disclosure remains visible");
        assert!(
            missing
                .spans
                .iter()
                .all(|span| span.style.fg != Some(Color::Green)),
            "missing outcome was styled as a success: {missing:?}"
        );
    }

    #[test]
    fn ticket_overview_wraps_the_first_useful_sanitized_blocker_reason() {
        let snapshot = json!({
            "run":{"id":"run-private","goal":"Repair it","status":"blocked","profile_id":"software"},
            "board":{"ticket_workflows":{"TK-private":{
                "completed_steps":[],
                "ready_steps":[],
                "pending_steps":[],
                "active_worker_step":null,
                "worker_state":"idle"
            }}},
            "tickets":[{
                "id":"TK-private",
                "title":"Unsafe /Users/max/private-title.rs sha256:fedcba9876543210",
                "status":"blocked",
                "operation":"build",
                "workflow":[],
                "outputs":[],
                "blockers":[
                    {
                        "kind":"blocked",
                        "message":"blocked",
                        "created_at":"2026-07-14T20:00:00Z",
                        "related_ticket":null
                    },
                    {
                        "kind":"integration-failure",
                        "message":"Review failed for ticket TK-private at /Users/max/Desktop/private.rs after sha256:0123456789abcdef in journal-019fdeadbeef123456; revise the proof boundary.",
                        "created_at":"2026-07-14T20:01:00Z",
                        "related_ticket":"TK-private"
                    },
                    {
                        "kind":"another-failure",
                        "message":"A second durable issue remains.",
                        "created_at":"2026-07-14T20:02:00Z",
                        "related_ticket":null
                    }
                ]
            }]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.ticket_tab = crate::model::TicketTab::All;
        let ticket = model.selected_ticket_value().unwrap();
        let lines = ticket_blocker_lines(ticket, model.selected_run_data(), 32);
        let rendered = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let flattened = collapse_display_whitespace(&rendered);

        assert!(flattened.contains("Review failed"), "{rendered}");
        assert!(flattened.contains("the affected ticket"), "{rendered}");
        assert!(flattened.contains("a local path"), "{rendered}");
        assert!(flattened.contains("a content hash"), "{rendered}");
        assert!(flattened.contains("an internal record"), "{rendered}");
        assert!(rendered.contains("+2 more"), "{rendered}");
        for secret in [
            "TK-private",
            "/Users/max/Desktop/private.rs",
            "/Users/max/private-title.rs",
            "0123456789abcdef",
            "fedcba9876543210",
            "journal-019fdeadbeef123456",
            "2026-07-14T20:01:00Z",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
        for line in lines.iter().skip(1) {
            let width = line
                .spans
                .iter()
                .map(|span| span.content.width())
                .sum::<usize>();
            assert!(width <= 32, "blocker line is {width} cells wide: {line:?}");
        }
    }

    #[test]
    fn ticket_overview_retains_count_only_copy_when_blocker_reasons_are_noise() {
        let ticket = json!({
            "blockers":[
                {
                    "kind":"blocked",
                    "message":"blocked",
                    "created_at":"2026-07-14T20:00:00Z",
                    "related_ticket":null
                },
                {
                    "kind":"raw-record",
                    "message":"{\"run_id\":\"run-private\",\"path\":\"/tmp/private\"}",
                    "created_at":"2026-07-14T20:01:00Z",
                    "related_ticket":null
                },
                "untyped legacy payload"
            ]
        });
        let rendered = ticket_blocker_lines(&ticket, None, 80)
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(
            rendered.contains("! 3 blockers need attention"),
            "{rendered}"
        );
        assert!(!rendered.contains("run-private"), "{rendered}");
        assert!(!rendered.contains("/tmp/private"), "{rendered}");
        assert!(!rendered.contains("untyped legacy payload"), "{rendered}");
    }

    #[test]
    fn ticket_blocker_projection_redacts_adversarial_tokens_and_hard_wraps() {
        let ticket = json!({
            "blockers":[{
                "kind":"integration-failure",
                "message":"TK-aaaaaaaaaaaaaaaa and EV-secret failed ticket_id:opaque at private/checkout and private\\checkout for commit=deadbee and node@sha256:0123456789abcdef; compiler record {\"status\":\"blocked\",\"retry\":false}; revise the plan with 超長界面調整🙂 and extraordinarilylongunbrokentoken.\u{001b}[31m",
                "created_at":"2026-07-14T20:00:00Z",
                "related_ticket":null
            }]
        });
        let lines = ticket_blocker_lines(&ticket, None, 18);
        let rendered = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let flattened = collapse_display_whitespace(&rendered);
        let without_whitespace = rendered
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();

        assert!(flattened.contains("revise the plan"), "{rendered}");
        assert!(flattened.contains("internal compiler"), "{rendered}");
        assert!(without_whitespace.contains("超長界面調整🙂"), "{rendered}");
        assert!(
            without_whitespace.contains("extraordinarilylongunbrokentoken"),
            "{rendered}"
        );
        assert!(!rendered.contains('\u{001b}'), "{rendered:?}");
        for secret in [
            "TK-aaaaaaaaaaaaaaaa",
            "EV-secret",
            "ticket_id:opaque",
            "private/checkout",
            "private\\checkout",
            "commit=deadbee",
            "node@sha256:",
            "\"status\"",
            "\"retry\"",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
        for line in lines.iter().skip(1) {
            let width = line
                .spans
                .iter()
                .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
                .sum::<usize>();
            assert!(width <= 18, "blocker line is {width} cells wide: {line:?}");
        }
    }

    #[test]
    fn ticket_blocker_projection_rejects_placeholder_only_failure_copy() {
        let snapshot = json!({
            "run":{"id":"run-private","goal":"Repair it","status":"blocked"},
            "tickets":[{
                "id":"TK-private",
                "title":"Private work",
                "status":"blocked",
                "workflow":[],
                "outputs":[],
                "blockers":[
                    {
                        "kind":"integration-failure",
                        "message":"Failed for TK-private at /private/checkout",
                        "created_at":"2026-07-14T20:00:00Z",
                        "related_ticket":null
                    },
                    {
                        "kind":"compiler-error",
                        "message":"Error at path:private for commit:deadbee and hash:abcdef1 in ref(EV-secret) {\"run_id\":\"run-private\"}",
                        "created_at":"2026-07-14T20:01:00Z",
                        "related_ticket":null
                    }
                ]
            }]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.ticket_tab = crate::model::TicketTab::All;
        let ticket = model.selected_ticket_value().unwrap();
        let rendered = ticket_blocker_lines(ticket, model.selected_run_data(), 80)
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(
            rendered.contains("! 2 blockers need attention"),
            "{rendered}"
        );
        assert!(!rendered.contains("local path"), "{rendered}");
        assert!(!rendered.contains("internal compiler record"), "{rendered}");
        for secret in [
            "TK-private",
            "/private/checkout",
            "path:private",
            "commit:deadbee",
            "hash:abcdef1",
            "EV-secret",
            "run-private",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
    }

    #[test]
    fn exited_worker_is_a_failed_step_instead_of_a_live_agent() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Recover it","status":"active","profile_id":"research"},
            "board":{"ticket_workflows":{"ticket":{
                "completed_steps":[],
                "ready_steps":["first"],
                "pending_steps":["first","second"],
                "active_worker_step":"first",
                "worker_state":"exited_before_output"
            }}},
            "tickets":[{
                "id":"ticket",
                "title":"Recover failed work",
                "status":"in_progress",
                "operation":"build",
                "workflow":[
                    {"id":"first","persona":"builder"},
                    {"id":"second","persona":"reviewer"}
                ],
                "outputs":[],"blockers":[],"lease":{"worker_pid":12345}
            }],
            "graph":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus_tickets();
        let backend = TestBackend::new(140, 34);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("!─○"), "{rendered}");
        assert!(rendered.contains("needs recovery"), "{rendered}");
        assert!(
            rendered.contains("Worker exited before recording"),
            "{rendered}"
        );
        assert!(!rendered.contains("Working now"), "{rendered}");
        assert!(!rendered.contains("12345"), "{rendered}");
    }

    #[test]
    fn stage_controls_and_errors_are_human_facing_without_record_ids() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Operate safely","status":"active","profile_id":"default"},
            "validation_errors":["Compiler rejected the edge rule"],
            "stages":[{
                "definition":{"id":"stage-secret-019f","kind":"manual"},
                "status":"waiting"
            }],
            "external_loops":[{"id":"loop-secret-019f","status":"wait"}],
            "external_repairs":[{"id":"repair-secret-019f","status":"requested"}],
            "graph":[{"id":"node-secret-019f","type":"task","edges":{}}],
            "tickets":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus = Focus::Details;
        model.detail_panel = Panel::Stages;
        let backend = TestBackend::new(160, 42);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(
            rendered.contains("▶ Current Human decision stage"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Enter control current stage"),
            "{rendered}"
        );
        assert!(rendered.contains("○ Workflow step"), "{rendered}");
        assert!(rendered.contains("Waiting"), "{rendered}");
        assert!(rendered.contains("External review loop"), "{rendered}");
        assert!(rendered.contains("Repair request"), "{rendered}");
        assert!(rendered.contains("Untitled task"), "{rendered}");
        for secret in [
            "stage-secret",
            "loop-secret",
            "repair-secret",
            "node-secret",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }

        model.detail_panel = Panel::Overview;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(
            rendered.contains("Compiler rejected the edge rule"),
            "{rendered}"
        );
    }

    #[test]
    fn stage_categories_recover_human_semantics_from_normalized_pipeline_data() {
        let cases = [
            (
                json!({"kind":"action","title":"Validate intake","config":{"compiler_owned":true,"action":"planning.intake"}}),
                "Intake",
            ),
            (
                json!({"kind":"action","title":"Map the system","config":{"persona":"run-planner","prompt":"Map it"}}),
                "Planning",
            ),
            (
                json!({"kind":"checkpoint","title":"Initialize the run","config":null}),
                "Initialization",
            ),
            (
                json!({"kind":"orchestration","title":"Execute compiled work","config":null}),
                "Execution",
            ),
            (
                json!({"kind":"agent_review","title":"Independently review the run","config":null}),
                "Review",
            ),
            (
                json!({"kind":"checkpoint","title":"Check the completed run","config":{"checkpoint":"verification"}}),
                "Verification",
            ),
            (
                json!({"kind":"action","title":"Publish findings","config":{"action":"report"}}),
                "Report",
            ),
            (
                json!({"kind":"manual","title":"Approve the plan","config":null}),
                "Approval",
            ),
            (
                json!({"kind":"action","title":"Run configured automation","config":null}),
                "Automation",
            ),
            (
                json!({"kind":"checkpoint","title":"Confirm release readiness","config":null}),
                "Quality check",
            ),
        ];

        for (definition, expected) in cases {
            assert_eq!(
                pipeline_stage_category(&definition),
                expected,
                "{definition}"
            );
        }
    }

    #[test]
    fn stages_panel_uses_friendly_categories_without_clipping_at_supported_sizes() {
        for (width, height) in [(82, 24), (140, 36)] {
            let snapshot = json!({
                "run":{"id":"run-secret","goal":"Operate safely","status":"active","profile_id":"default"},
                "stages":[
                    {
                        "definition":{
                            "id":"planning-secret",
                            "kind":"action",
                            "title":"Plan architecture",
                            "config":{"persona":"run-planner","prompt":"Map it"}
                        },
                        "status":"running"
                    },
                    {
                        "definition":{
                            "id":"initialize-secret",
                            "kind":"checkpoint",
                            "title":"Initialize the run",
                            "config":null
                        },
                        "status":"pending"
                    },
                    {
                        "definition":{
                            "id":"orchestrate-secret",
                            "kind":"orchestration",
                            "title":"Execute compiled work",
                            "config":null
                        },
                        "status":"pending"
                    }
                ],
                "tickets":[],
                "graph":[]
            });
            let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
            model.focus = Focus::Details;
            model.detail_panel = Panel::Stages;
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();

            terminal.draw(|frame| draw(frame, &model)).unwrap();
            let rendered = rendered_text(&terminal);

            for visible in ["Planning", "Initialization", "Execution"] {
                assert!(rendered.contains(visible), "missing {visible}: {rendered}");
            }
            for runtime_kind in ["  Action", "  Checkpoint", "  Orchestration"] {
                assert!(!rendered.contains(runtime_kind), "{rendered}");
            }
            for secret in ["planning-secret", "initialize-secret", "orchestrate-secret"] {
                assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
            }
        }
    }

    #[test]
    fn narrow_stage_cards_keep_status_and_category_together() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Operate safely","status":"active","profile_id":"default"},
            "stages":[],
            "tickets":[],
            "graph":[]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let stages = [json!({
            "definition":{
                "id":"synchronize",
                "kind":"action",
                "title":"Synchronize the target branch",
                "config":null
            },
            "status":"pending"
        })];

        let rendered = pipeline_stage_cards(&stages, model.selected_run_data(), &model, 39)
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            rendered.contains("○ Synchronize the target branch\n  Pending · Automation"),
            "{rendered}"
        );
    }

    #[test]
    fn paused_run_projects_its_open_stage_as_paused_until_work_resumes() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Operate safely","status":"active","profile_id":"default"},
            "orchestration":{"running":false,"max_parallel":1,"unchained":false},
            "stages":[],
            "tickets":[],
            "graph":[]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let stages = [json!({
            "definition":{
                "id":"orchestrate",
                "kind":"orchestration",
                "title":"Execute compiled work",
                "config":null
            },
            "status":"running"
        })];

        let rendered = pipeline_stage_cards(&stages, model.selected_run_data(), &model, 50)
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            rendered.contains("○ Execute compiled work  Paused"),
            "{rendered}"
        );
        assert!(!rendered.contains("Running"), "{rendered}");
    }

    #[test]
    fn live_stage_terminal_pause_and_error_reasons_redact_control_ids_only_for_display() {
        let run_id = "019f551e-7fb4-7862-889a-890af6d0314e";
        let agent_id = "orchestration-orchestrate";
        let ticket_id = "TK-2032fc62e13c354f";
        let terminal_reason = format!(
            "lead {agent_id} exited before the compiler board reached terminal state. Run {run_id}, stage orchestrate, and ticket {ticket_id} remain bound to C1 and G2."
        );
        let snapshot = json!({
            "run":{
                "id":run_id,
                "goal":"Evaluate sortedness",
                "status":"active",
                "profile_id":"research"
            },
            "stages":[
                {
                    "definition":{
                        "id":"orchestrate",
                        "title":"Execute research program",
                        "kind":"orchestration"
                    },
                    "status":"blocked",
                    "terminal_reason":terminal_reason
                },
                {
                    "definition":{
                        "id":"evidence-review",
                        "title":"Review evidence",
                        "kind":"review"
                    },
                    "status":"paused",
                    "pause_reason":format!(
                        "Agent {agent_id} paused stage evidence-review for ticket {ticket_id}; C1 remains unchanged."
                    )
                },
                {
                    "definition":{
                        "id":"report",
                        "title":"Compile report",
                        "kind":"action"
                    },
                    "status":"failed",
                    "error":{
                        "message":format!(
                            "Run {run_id} could not recover agent {agent_id} while preserving G2."
                        )
                    }
                }
            ],
            "agents":[{
                "id":agent_id,
                "run_id":run_id,
                "stage_id":"orchestrate",
                "persona":"lead",
                "status":"exited"
            }],
            "tickets":[{
                "id":ticket_id,
                "title":"drill-hypothesis: Sortedness hypothesis C1",
                "operation":"drill-hypothesis",
                "status":"in_progress",
                "workflow":[],
                "outputs":[],
                "blockers":[]
            }],
            "graph":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus = Focus::Details;
        model.detail_panel = Panel::Stages;

        let text = detail_lines(&model, 80);
        let rendered = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            rendered.contains("lead agent exited before the compiler board reached terminal state"),
            "{rendered}"
        );
        assert!(rendered.contains("this run"), "{rendered}");
        assert!(
            rendered.contains("stage “Execute research program”"),
            "{rendered}"
        );
        assert!(
            rendered.contains("ticket “Sortedness hypothesis C1”"),
            "{rendered}"
        );
        assert!(
            rendered.contains("Agent paused stage “Review evidence”"),
            "{rendered}"
        );
        assert!(rendered.contains("could not recover agent"), "{rendered}");
        assert!(rendered.contains("C1"), "{rendered}");
        assert!(rendered.contains("G2"), "{rendered}");
        for secret in [run_id, agent_id, ticket_id, "stage orchestrate"] {
            assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
        }
        assert_eq!(
            model.runs[0].stages[0]["terminal_reason"], terminal_reason,
            "display redaction must never mutate the durable stage record"
        );
    }

    #[test]
    fn report_uses_selected_ticket_graph_and_action_journal_health() {
        let snapshot = json!({
            "run":{"id":"run","goal":"Report truth","status":"active","profile_id":"default"},
            "board":{
                "failed_journals":["internal-journal-id"],
                "incomplete_journals":[],
                "incomplete_integrations":[]
            },
            "graph":[{"id":"integration","type":"task","title":"Integration","edges":{}}],
            "ticket_graphs":{"ticket":{"graph":[
                {"id":"one","type":"task","title":"One","edges":{}},
                {"id":"two","type":"task","title":"Two","edges":{}}
            ]}},
            "tickets":[{"id":"ticket","title":"Selected work","status":"in_progress","workflow":[],"outputs":[],"blockers":[]}]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus = Focus::Details;
        model.detail_panel = Panel::Overview;
        model.overview_subject = OverviewSubject::Ticket;
        let backend = TestBackend::new(140, 34);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("ATTENTION"), "{rendered}");
        assert!(rendered.contains("1 failed action"), "{rendered}");
        assert!(rendered.contains("◇2 nodes"), "{rendered}");
        assert!(!rendered.contains("internal-journal-id"), "{rendered}");
    }

    #[test]
    fn report_health_requires_complete_telemetry_and_recorded_evidence() {
        let workflow_row = |review_status: Value, pending_steps: Vec<Value>, worker_state: &str| {
            json!({
                "status":"in_progress",
                "completed_steps":[],
                "ready_steps":[],
                "pending_steps":pending_steps,
                "active_worker_step":null,
                "worker_state":worker_state,
                "review_status":review_status
            })
        };
        let complete_snapshot =
            |tickets: Vec<Value>,
             stages: Vec<Value>,
             failed_journals: Vec<Value>,
             overrides: BTreeMap<String, Value>| {
                let ticket_workflows = tickets
                    .iter()
                    .filter_map(|ticket| {
                        let ticket_id = ticket.get("id").and_then(Value::as_str)?;
                        let progress = overrides
                            .get(ticket_id)
                            .cloned()
                            .unwrap_or_else(|| workflow_row(Value::Null, Vec::new(), "idle"));
                        Some((ticket_id.to_owned(), progress))
                    })
                    .collect::<serde_json::Map<_, _>>();
                json!({
                    "run":{"id":"run","goal":"Report truth","status":"active","profile_id":"default"},
                    "validation_errors":[],
                    "board":{
                        "failed_journals":failed_journals,
                        "incomplete_journals":[],
                        "incomplete_integrations":[],
                        "ticket_workflows":ticket_workflows
                    },
                    "tickets":tickets,
                    "stages":stages,
                    "graph":[]
                })
            };
        let ticket_output = json!({
            "id":"ticket",
            "status":"in_progress",
            "workflow":[],
            "outputs":[{"id":"current-output","step_id":"build"}],
            "reviews":[],
            "blockers":[]
        });
        let passed_review = json!({
            "id":"ticket",
            "status":"review",
            "workflow":[{"id":"review","kind":"review"}],
            "outputs":[],
            "reviews":[{"status":"passed"}],
            "blockers":[]
        });
        let verification = json!({
            "status":"succeeded",
            "definition":{"kind":"checkpoint","config":{"checkpoint":"verification"}},
            "output":{}
        });

        let mut incomplete_with_output =
            complete_snapshot(vec![ticket_output.clone()], vec![], vec![], BTreeMap::new());
        incomplete_with_output
            .as_object_mut()
            .unwrap()
            .remove("validation_errors");
        let mut missing_ticket_workflow =
            complete_snapshot(vec![ticket_output.clone()], vec![], vec![], BTreeMap::new());
        missing_ticket_workflow["board"]["ticket_workflows"] = json!({});
        let failed_review = BTreeMap::from([(
            "ticket".to_owned(),
            workflow_row(json!("failed"), vec![json!("review")], "idle"),
        )]);
        let passed_current_review = BTreeMap::from([(
            "ticket".to_owned(),
            workflow_row(json!("passed"), vec![], "idle"),
        )]);
        let stale_passed_review = BTreeMap::from([(
            "ticket".to_owned(),
            workflow_row(json!("passed"), vec![json!("review")], "idle"),
        )]);
        let cases = [
            (
                "bare snapshot",
                json!({"run":{"id":"run","goal":"Report truth","status":"active"}}),
                EvidenceHealth::NoRecordedIssues,
            ),
            (
                "complete but empty",
                complete_snapshot(vec![], vec![], vec![], BTreeMap::new()),
                EvidenceHealth::NoRecordedIssues,
            ),
            (
                "current ticket output",
                complete_snapshot(vec![ticket_output.clone()], vec![], vec![], BTreeMap::new()),
                EvidenceHealth::Recorded(EvidenceBasis::TicketResult),
            ),
            (
                "incomplete telemetry with output",
                incomplete_with_output,
                EvidenceHealth::NoRecordedIssues,
            ),
            (
                "ticket workflow row missing",
                missing_ticket_workflow,
                EvidenceHealth::NoRecordedIssues,
            ),
            (
                "passed current review",
                complete_snapshot(
                    vec![passed_review.clone()],
                    vec![],
                    vec![],
                    passed_current_review,
                ),
                EvidenceHealth::Recorded(EvidenceBasis::PassedReview),
            ),
            (
                "stale passed review is not current review evidence",
                complete_snapshot(
                    vec![json!({
                        "id":"ticket",
                        "status":"review",
                        "workflow":[{"id":"review","kind":"review"}],
                        "outputs":[{"id":"new-current-output","step_id":"build"}],
                        "reviews":[{"status":"passed"}],
                        "blockers":[]
                    })],
                    vec![],
                    vec![],
                    stale_passed_review,
                ),
                EvidenceHealth::Recorded(EvidenceBasis::TicketResult),
            ),
            (
                "failed current review wins over output",
                complete_snapshot(
                    vec![json!({
                        "id":"ticket",
                        "status":"review",
                        "workflow":[{"id":"review","kind":"review"}],
                        "outputs":[{"id":"current-output","step_id":"build"}],
                        "reviews":[{"status":"failed"}],
                        "blockers":[]
                    })],
                    vec![],
                    vec![],
                    failed_review,
                ),
                EvidenceHealth::Attention,
            ),
            (
                "successful verification",
                complete_snapshot(vec![], vec![verification], vec![], BTreeMap::new()),
                EvidenceHealth::Recorded(EvidenceBasis::Verification),
            ),
            (
                "failed pipeline wins over output",
                complete_snapshot(
                    vec![ticket_output.clone()],
                    vec![json!({"status":"failed","output":{"reason":"failed"}})],
                    vec![],
                    BTreeMap::new(),
                ),
                EvidenceHealth::Attention,
            ),
            (
                "blocked pipeline wins over output",
                complete_snapshot(
                    vec![ticket_output.clone()],
                    vec![json!({"status":"blocked","output":{"reason":"blocked"}})],
                    vec![],
                    BTreeMap::new(),
                ),
                EvidenceHealth::Attention,
            ),
            (
                "known issue wins over output",
                complete_snapshot(
                    vec![ticket_output],
                    vec![],
                    vec![json!("failed-journal")],
                    BTreeMap::new(),
                ),
                EvidenceHealth::Attention,
            ),
        ];

        for (label, snapshot, expected) in cases {
            let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
            let run = &model.runs[0];
            let summary = run.summary.as_ref().unwrap();
            assert_eq!(evidence_health(run, summary), expected, "{label}");
            let text = report_text(run, 0, &model, true);
            let rendered = text
                .lines
                .iter()
                .flat_map(|line| line.spans.iter())
                .map(|span| span.content.as_ref())
                .collect::<String>();
            assert!(!rendered.contains("HEALTHY"), "{label}: {rendered}");
            if label == "failed current review wins over output" {
                assert!(rendered.contains("1 review failed"), "{rendered}");
            }
            if matches!(
                label,
                "failed pipeline wins over output" | "blocked pipeline wins over output"
            ) {
                assert!(
                    rendered.contains("1 pipeline stage failed or blocked"),
                    "{rendered}"
                );
            }
            match expected {
                EvidenceHealth::Attention => {
                    assert!(rendered.contains("ATTENTION"), "{label}: {rendered}");
                    assert!(
                        !rendered.contains("Evidence recorded"),
                        "{label}: {rendered}"
                    );
                }
                EvidenceHealth::Recorded(basis) => {
                    assert!(
                        rendered.contains("Evidence recorded"),
                        "{label}: {rendered}"
                    );
                    assert!(rendered.contains("no known issues"), "{label}: {rendered}");
                    let expanded = report_text(run, 0, &model, false)
                        .lines
                        .iter()
                        .flat_map(|line| line.spans.iter())
                        .map(|span| span.content.as_ref())
                        .collect::<String>();
                    assert!(
                        expanded.contains(evidence_basis_detail(basis)),
                        "{label}: {expanded}"
                    );
                }
                EvidenceHealth::NoRecordedIssues => {
                    assert!(
                        rendered.contains("No recorded issues"),
                        "{label}: {rendered}"
                    );
                    assert!(
                        !rendered.contains("Evidence recorded"),
                        "{label}: {rendered}"
                    );
                    let neutral = text
                        .lines
                        .iter()
                        .flat_map(|line| line.spans.iter())
                        .find(|span| span.content.contains("No recorded issues"))
                        .unwrap();
                    assert_eq!(neutral.style.fg, Some(Color::DarkGray), "{label}");
                    assert_eq!(neutral.style.bg, None, "{label}");
                }
            }
        }
    }

    #[test]
    fn configured_report_is_not_presented_as_a_recorded_final_report() {
        let configured = json!({
            "run":{"id":"run","goal":"Report truth","status":"active"},
            "validation_errors":[],
            "board":{
                "failed_journals":[],
                "incomplete_journals":[],
                "incomplete_integrations":[],
                "ticket_workflows":{}
            },
            "tickets":[],
            "stages":[],
            "views":[{"id":"final-report","kind":"report"}]
        });
        let configured_model = ControlCenterModel::from_snapshot("/tmp/project".into(), configured);
        let configured_run = &configured_model.runs[0];
        assert_eq!(
            evidence_health(configured_run, configured_run.summary.as_ref().unwrap()),
            EvidenceHealth::NoRecordedIssues
        );
        assert_eq!(final_report_status(configured_run), "No final report yet.");

        let recorded = json!({
            "run":{"id":"run","goal":"Report truth","status":"active"},
            "validation_errors":[],
            "board":{
                "failed_journals":[],
                "incomplete_journals":[],
                "incomplete_integrations":[],
                "ticket_workflows":{}
            },
            "tickets":[],
            "stages":[{
                "status":"succeeded",
                "definition":{"kind":"action","config":{"action":"report"}},
                "output":{}
            }],
            "views":[{"id":"final-report","kind":"report"}]
        });
        let recorded_model = ControlCenterModel::from_snapshot("/tmp/project".into(), recorded);
        let recorded_run = &recorded_model.runs[0];
        assert_eq!(
            evidence_health(recorded_run, recorded_run.summary.as_ref().unwrap()),
            EvidenceHealth::Recorded(EvidenceBasis::FinalReport)
        );
        assert_eq!(final_report_status(recorded_run), "Final report recorded.");
    }

    #[test]
    fn run_overview_marks_only_live_planning_as_token_spending_work() {
        let live_snapshot = json!({
            "run":{"id":"run-live","goal":"Plan safely","status":"planning","run_type":"large"},
            "agents":[{"id":"planner","persona":"planner","status":"running"}],
            "tickets":[],
            "graph":[]
        });
        let live_model = ControlCenterModel::from_snapshot("/tmp/project".into(), live_snapshot);
        let live_run = &live_model.runs[0];
        let live_summary = live_run.summary.as_ref().unwrap();
        let live = run_overview_text(live_run, live_summary, "Large", &live_model).lines[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(live.contains("⚙"), "{live}");
        assert!(live.contains("Planning"), "{live}");

        let quiet_snapshot = json!({
            "run":{"id":"run-quiet","goal":"Await input","status":"planning","run_type":"large"},
            "agents":[],
            "tickets":[],
            "graph":[]
        });
        let quiet_model = ControlCenterModel::from_snapshot("/tmp/project".into(), quiet_snapshot);
        let quiet_run = &quiet_model.runs[0];
        let quiet_summary = quiet_run.summary.as_ref().unwrap();
        let quiet = run_overview_text(quiet_run, quiet_summary, "Large", &quiet_model).lines[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(quiet.contains("○"), "{quiet}");
        assert!(!quiet.contains("⚙"), "{quiet}");
    }

    #[test]
    fn overview_composes_objective_run_and_evidence_before_preserving_ticket_focus() {
        let objective = "Objective line one\nObjective line two\nObjective line three\nObjective line four\nObjective line five\nObjective line six";
        let snapshot = json!({
            "run":{
                "id":"run-secret",
                "goal":objective,
                "status":"active",
                "profile_id":"default"
            },
            "tickets":[{
                "id":"ticket-secret",
                "title":"Ticket-level implementation",
                "status":"in_progress",
                "operation":"implement",
                "workflow":[],
                "outputs":[],
                "blockers":[]
            }],
            "graph":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let rendered = |model: &ControlCenterModel| {
            detail_lines(model, 80)
                .lines
                .iter()
                .flat_map(|line| line.spans.iter())
                .map(|span| span.content.as_ref())
                .collect::<Vec<_>>()
                .join("\n")
        };

        model.focus_runs();
        let collapsed = rendered(&model);
        for section in ["Objective", "Run", "Evidence"] {
            assert!(
                collapsed.contains(section),
                "missing {section}: {collapsed}"
            );
        }
        assert!(collapsed.contains("tickets complete"), "{collapsed}");
        assert!(collapsed.contains("No recorded issues"), "{collapsed}");
        assert!(!collapsed.contains("HEALTHY"), "{collapsed}");
        assert!(collapsed.contains("Objective line four…"), "{collapsed}");
        assert!(!collapsed.contains("Objective line six"), "{collapsed}");

        model.focus = Focus::Details;
        let expanded = rendered(&model);
        assert!(expanded.contains("Objective line six"), "{expanded}");
        assert!(expanded.contains("tickets complete"), "{expanded}");
        assert!(expanded.contains("No recorded issues"), "{expanded}");
        assert!(!expanded.contains("HEALTHY"), "{expanded}");

        model.focus_tickets();
        model.focus = Focus::Details;
        let ticket_overview = rendered(&model);
        assert!(
            ticket_overview.contains("Ticket-level implementation"),
            "{ticket_overview}"
        );
        assert_eq!(model.overview_subject, OverviewSubject::Ticket);
    }

    #[test]
    fn plan_panel_switches_from_live_activity_to_the_full_approved_human_plan() {
        let snapshot = json!({
            "run":{
                "id":"run-secret",
                "goal":"Replace the questionnaire section",
                "status":"active",
                "run_type_title":"Medium"
            },
            "stages":[
                {
                    "status":"succeeded",
                    "definition":{
                        "id":"combined-plan",
                        "title":"Plan the focused slice",
                        "kind":"planning",
                        "required":true
                    },
                    "output":{"output":{
                        "output":"Complete compiler-facing plan text",
                        "review":{
                            "architecture":[{
                                "heading":"Shared field contract",
                                "description":"Use one definition across both questionnaire surfaces."
                            }],
                            "risk":[{
                                "heading":"Preserve legacy notes",
                                "description":"Migrate without detaching existing values."
                            }],
                            "verification":[{
                                "heading":"Prove both surfaces",
                                "description":"Exercise persistence and rendering with focused tests."
                            }]
                        },
                        "graph_seed":{
                            "root_spec":{"acceptance_intent":"Approval is explicit"},
                            "nodes":[{
                                "key":"seed-key-secret",
                                "type":"change",
                                "title":"Preserve the shared field contract",
                                "spec":{"purpose":"Keep both questionnaire surfaces aligned"}
                            }],
                            "edges":[{
                                "source":"$root",
                                "relation":"decomposes_into",
                                "target":"seed-key-secret"
                            }]
                        }
                    }}
                },
                {
                    "status":"succeeded",
                    "definition":{
                        "id":"explicit_run_approval",
                        "title":"Approve the plan",
                        "kind":"approval"
                    }
                }
            ],
            "planning_transcript":[{
                "type":"planning.agent.started",
                "stage_id":"combined-plan",
                "at":"2026-07-14T03:04:05Z"
            }]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.detail_panel = Panel::Planning;
        let rendered = detail_lines(&model, 76)
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("\n");

        for expected in [
            "Approved plan",
            "Plan the focused slice",
            "Complete compiler-facing plan text",
            "Graph Seed",
            "1 root fact · 1 semantic node · 1 relationship",
            "Objective → decomposes into → Preserve the shared field contract",
        ] {
            assert!(
                rendered.contains(expected),
                "missing {expected}: {rendered}"
            );
        }
        assert!(!rendered.contains("Use one definition across both questionnaire surfaces."));
        assert!(!rendered.contains("seed-key-secret"), "{rendered}");

        model.runs[0].stages[1]["status"] = Value::String("pending".to_owned());
        let planning = detail_lines(&model, 76)
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!planning.contains("Approved plan"), "{planning}");
    }

    #[test]
    fn action_palette_is_contextual_and_human_readable() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Do the work","status":"active","profile_id":"default"},
            "tickets":[{
                "id":"ticket-secret",
                "title":"Selected work",
                "status":"in_progress",
                "blockers":[],
                "workflow":[],
                "outputs":[],
                "lease":{"worktree":"/tmp/ticket-secret"}
            }],
            "actions":[
                {
                    "id":"context",
                    "allowed_ticket_states":["in_progress"],
                    "requires_ticket_worktree":true,
                    "params":{"ticket_id":{"type":"ticket_id","required":true}}
                },
                {"id":"rollback"}
            ],
            "views":[{"id":"tickets","kind":"tabbed_table","actions":["context"]}],
            "graph":[]
        });
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        model.focus = Focus::Tickets;
        model.open_action_palette();
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("Prepare agent context"), "{rendered}");
        assert!(
            rendered.contains("Materialize the scoped context pack"),
            "{rendered}"
        );
        assert!(!rendered.contains("rollback"), "{rendered}");
        assert!(!rendered.contains("ticket-secret"), "{rendered}");
    }

    #[test]
    fn narrow_operate_layout_keeps_switchers_and_progress_visible() {
        let snapshot = json!({
            "run":{"id":"run-secret","goal":"Compact run","status":"active","profile_id":"research"},
            "board":{"ticket_workflows":{"TK-secret":{
                "completed_steps":["plan"],
                "ready_steps":[],
                "pending_steps":["build"],
                "active_worker_step":"build",
                "worker_state":"running"
            }}},
            "tickets":[{
                "id":"TK-secret","title":"Compact ticket","status":"in_progress","operation":"build",
                "workflow":[{"id":"plan","persona":"planner"},{"id":"build","persona":"builder"}],
                "outputs":[],"blockers":[]
            }],
            "graph":[{"id":"node-secret","type":"task","title":"Compact node","edges":{}}]
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("Active 1"), "{rendered}");
        assert!(rendered.contains("Overview"), "{rendered}");
        assert!(rendered.contains("●─◐"), "{rendered}");
        assert!(!rendered.contains("TK-secret"), "{rendered}");
        let details = rendered_cell_position(&terminal, "D:Overview").unwrap();
        let graph = rendered_cell_position(&terminal, "Project graph").unwrap();
        assert!(details.0 < graph.0, "details={details:?}, graph={graph:?}");
    }

    #[test]
    fn run_type_question_fields_are_labeled_as_planning_questions() {
        let resource = ConfigResource {
            key: "large".to_owned(),
            title: "Large".to_owned(),
            subtitle: "Run behavior, intake, and planning questions".to_owned(),
            domain: ConfigDomain::RunTypes,
            document_path: std::path::PathBuf::from("run-types/large.yaml"),
            kind: crate::configure::ConfigResourceKind::RunType,
            locator: Vec::new(),
            linked_locators: Vec::new(),
            linked_documents: Vec::new(),
        };

        assert_eq!(
            semantic_form_parts(&resource, "$.questions.policy"),
            ("Planning Questions".to_owned(), "Policy".to_owned())
        );
        assert_eq!(
            semantic_form_parts(&resource, "$.questions.default_scope"),
            ("Planning Questions".to_owned(), "Default scope".to_owned())
        );
    }

    #[test]
    fn gate_policy_guided_fields_use_semantic_sections_and_labels() {
        let resource = ConfigResource {
            key: "gate-policy".to_owned(),
            title: "Research readiness".to_owned(),
            subtitle: "Capability-aware verifier selection".to_owned(),
            domain: ConfigDomain::GraphRules,
            document_path: std::path::PathBuf::from("graph.yaml"),
            kind: crate::configure::ConfigResourceKind::GatePolicy,
            locator: Vec::new(),
            linked_locators: Vec::new(),
            linked_documents: Vec::new(),
        };
        for (path, expected_group, expected_field) in [
            (
                "$.capability.required_name_fields[0]",
                "Capability contract",
                "Required name fields 1",
            ),
            ("$.selection.mode", "Provider selection", "Selection mode"),
            (
                "$.selection.tie_break.direction",
                "Provider selection",
                "Tie-break direction",
            ),
            (
                "$.evaluation_targets.cardinality",
                "Evaluation context",
                "Target cardinality",
            ),
            (
                "$.applicability.context_class_order[3]",
                "Applicability & inheritance",
                "Context class order 4",
            ),
            (
                "$.passing_receipt_statuses[0]",
                "Verification evidence",
                "Passing receipt status",
            ),
            (
                "$.execution_ready.all[0].op",
                "Execution readiness",
                "Readiness rule 1",
            ),
            (
                "$.applicability.required_subject_node_types[0]",
                "Required coverage",
                "Required subject type 1",
            ),
            (
                "$.missing_gate_obligation_key_template",
                "Required coverage",
                "Missing-gate blocker name",
            ),
            (
                "$.auto_evaluate.check",
                "Automatic evaluation",
                "Verifier check",
            ),
            (
                "$.auto_evaluate.boundaries[1]",
                "Automatic evaluation",
                "Evaluation boundary 2",
            ),
        ] {
            assert_eq!(
                semantic_form_parts(&resource, path),
                (expected_group.to_owned(), expected_field.to_owned())
            );
        }
        assert_eq!(
            config_resource_group(ConfigDomain::GraphRules, &resource),
            "Gate policies"
        );
        assert_eq!(
            semantic_form_display_value(
                &resource,
                "$.execution_ready.all[0].op",
                "filesystem_manifest_current"
            ),
            "Files match approved manifest"
        );
        assert_eq!(
            semantic_form_display_value(&resource, "$.auto_evaluate.boundaries[0]", "full"),
            "Full project compile"
        );
        assert_eq!(
            semantic_form_display_value(
                &resource,
                "$.missing_gate_obligation_key_template",
                "gate.required.{{ subject.id }}"
            ),
            "Gate required each subject"
        );
        for path in [
            "$.applicability.required_subject_node_types[0]",
            "$.missing_gate_obligation_key_template",
            "$.execution_ready.all[0].op",
            "$.auto_evaluate.check",
        ] {
            assert!(
                semantic_form_explanation(&resource, path).is_some(),
                "missing guided explanation for {path}"
            );
        }
    }
}
