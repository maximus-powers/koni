use std::collections::{BTreeMap, BTreeSet};

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::configure::{ConfigDomain, ConfigResource};
use crate::graph::GraphRenderer;
use crate::help::{HelpAction, HelpTopic};
use crate::model::{
    AnswerDraft, ApprovalDraft, ControlCenterModel, Dialog, EditScalarDraft, Focus, Mode,
    NewRunDraft, OverviewSubject, Panel, RunData, RunSummary, RunTypeOption,
    configured_orchestration_key_is_protected, question_answer_is_pending_resume,
};

const MIN_WIDTH: u16 = 82;
const MIN_HEIGHT: u16 = 20;
pub(crate) const CONFIG_DOMAIN_ROW_HEIGHT: u16 = 1;
pub(crate) const CONFIG_RESOURCE_CARD_HEIGHT: u16 = 2;

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
        .constraints([Constraint::Length(3), Constraint::Min(8)])
        .split(area);
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(25),
            Constraint::Percentage(30),
            Constraint::Min(32),
        ])
        .split(rows[1]);
    ConfigureLayout {
        draft_bar: Some(rows[0]),
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
        Dialog::Approval(_) => centered_box(110, 32, frame.area()),
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
            (9 + u16::try_from(draft.params.len()).unwrap_or(8) * 2).min(26),
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
                    "Answer is durable; Enter retries the bound session resume.",
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
            for (index, (_, label, description, recommended)) in draft.options.iter().enumerate() {
                lines.push(Line::styled(
                    format!(
                        "{} {}{}",
                        if index == draft.selected { "▸" } else { " " },
                        label,
                        if *recommended { "  (recommended)" } else { "" }
                    ),
                    if index == draft.selected {
                        Style::default().fg(Color::Cyan)
                    } else {
                        Style::default()
                    },
                ));
                if index == draft.selected && !description.is_empty() {
                    lines.extend(
                        wrap_full_text(description, content_width.saturating_sub(4))
                            .into_iter()
                            .map(|line| {
                                Line::styled(
                                    format!("    {line}"),
                                    Style::default().fg(Color::DarkGray),
                                )
                            }),
                    );
                }
            }
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                if draft.allow_custom {
                    format!(
                        "Custom{}: {}",
                        if draft.custom_active { " ▸" } else { "" },
                        draft.custom
                    )
                } else {
                    "Custom answers disabled for this question".to_owned()
                },
                if draft.custom_active && (!draft.pending_resume || draft.waiting_for_batch) {
                    Style::default().fg(Color::Cyan)
                } else {
                    Style::default().fg(Color::DarkGray)
                },
            ));
            frame.render_widget(
                Paragraph::new(lines)
                    .block(Block::default().borders(Borders::ALL).title(
                        if draft.waiting_for_batch {
                            " Revise answer "
                        } else {
                            " Answer agent "
                        },
                    ))
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
            lines.extend([
                Line::raw(""),
                Line::styled(
                    "Type to filter · Enter to configure · Esc to close",
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
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
                            .title(format!(" Available actions{filter} ")),
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
                        .title(format!(" Edit {field} ")),
                ),
                area,
            );
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
                    if action.submitted {
                        "Executing… · Esc closes this view; the action remains durable"
                    } else {
                        "Tab: next parameter · Enter: execute · Esc: cancel"
                    },
                    Style::default().fg(Color::DarkGray),
                ),
                Line::styled(
                    "Execution is compiler-mediated and lifecycle-validated.",
                    Style::default().fg(Color::Yellow),
                ),
            ]);
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::Cyan))
                            .title(" Configured action "),
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
                        "Enter: create draft · Esc: cancel",
                        Style::default().fg(Color::DarkGray),
                    ),
                    Line::styled(
                        "The document is published only after full catalog/profile validation.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Cyan))
                        .title(" New configuration document "),
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
                        "Enter: stage rename · Esc: cancel",
                        Style::default().fg(Color::DarkGray),
                    ),
                    Line::styled(
                        "Rename and reference edits publish together after full validation.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Cyan))
                        .title(" Rename configuration document "),
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
                        "Enter: stage conversion · Esc: cancel",
                        Style::default().fg(Color::DarkGray),
                    ),
                    Line::styled(
                        "Nothing is replaced now. Ctrl-P validates and publishes all files together.",
                        Style::default().fg(Color::Yellow),
                    ),
                ])
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Yellow))
                        .title(" Migrate Legacy configuration "),
                )
                .wrap(Wrap { trim: false }),
                area,
            );
        }
        Dialog::DeleteRun(draft) => {
            let preview = &draft.preview;
            let mut lines = vec![
                Line::styled(
                    if preview.goal.trim().is_empty() {
                        "Selected run".to_owned()
                    } else {
                        preview.goal.clone()
                    },
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
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
            ];
            if !preview.blockers.is_empty() {
                lines.push(Line::styled(
                    format!(
                        "! {} safety blocker{} must be resolved before removal",
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
                Line::styled("Choose an action", heading_style()),
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
            lines.push(Line::styled(
                if draft.submitted {
                    "Removing the selected run through the engine…"
                } else if draft.selected == 2 && draft.confirm_owned_branches {
                    "Strong confirmation: press Enter again to delete proven owned branches."
                } else if !preview.can_delete && draft.selected > 0 {
                    "Removal is disabled until every safety blocker is cleared."
                } else {
                    "↑/↓ choose · Enter confirm · Esc cancel"
                },
                Style::default().fg(if draft.selected == 2 {
                    Color::Yellow
                } else {
                    Color::DarkGray
                }),
            ));
            frame.render_widget(
                Paragraph::new(lines)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::LightRed))
                            .title(" Delete run "),
                    )
                    .wrap(Wrap { trim: false }),
                area,
            );
        }
    }
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
            "Answer is durable; Enter retries the bound session resume.".to_owned()
        } else {
            "Recording answer and resuming agent…".to_owned()
        };
        lines += wrap_full_text(&status, width).len();
        if draft.submitted && (draft.waiting_for_batch || draft.pending_resume) {
            lines += 1;
        }
    }
    lines += 1;
    for (index, (_, label, description, recommended)) in draft.options.iter().enumerate() {
        let label = format!(
            "  {label}{}",
            if *recommended { "  (recommended)" } else { "" }
        );
        lines += wrap_full_text(&label, width).len();
        if index == draft.selected && !description.is_empty() {
            lines += wrap_full_text(description, width.saturating_sub(4)).len();
        }
    }
    lines += 1;
    let custom = if draft.allow_custom {
        format!("Custom: {}", draft.custom)
    } else {
        "Custom answers disabled for this question".to_owned()
    };
    lines += wrap_full_text(&custom, width).len();
    u16::try_from(lines.saturating_add(2))
        .unwrap_or(u16::MAX)
        .max(12)
}

fn draw_approval_dialog(frame: &mut Frame<'_>, area: Rect, draft: &ApprovalDraft) {
    let outer = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" Review planning and approve ");
    let inner = outer.inner(area);
    frame.render_widget(outer, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Min(5),
            Constraint::Length(1),
            Constraint::Length(2),
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

    let compact_tabs = rows[1].width < 100;
    let mut tab_spans = vec![Span::raw(" ")];
    for (index, section) in draft.sections.iter().enumerate() {
        let label = if compact_tabs {
            match section.title.as_str() {
                "Resolved decisions" => "Decisions",
                "Architecture plan" => "Architecture",
                "Risk plan" => "Risks",
                "Verification plan" => "Verification",
                title => title,
            }
        } else {
            section.title.as_str()
        };
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
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(tab_spans).alignment(Alignment::Center),
            Line::styled("←/→ sections", Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center),
        ]),
        rows[1],
    );

    let section = draft.selected_section();
    let section_title = section.map_or("Planning review", |section| section.title.as_str());
    let section_count = draft.sections.len().max(1);
    let content_block = Block::default().borders(Borders::ALL).title(format!(
        " {}/{} · {} ",
        draft.selected_section.saturating_add(1).min(section_count),
        section_count,
        section_title
    ));
    let content_inner = content_block.inner(rows[2]);
    frame.render_widget(content_block, rows[2]);
    let body = section.map_or("No durable review text is available.", |section| {
        section.body.as_str()
    });
    let body_lines = approval_wrapped_lines(body, usize::from(content_inner.width).max(1));
    let visible = usize::from(content_inner.height).max(1);
    let max_scroll = body_lines.len().saturating_sub(visible);
    let scroll = draft.scroll.min(max_scroll);
    let end = scroll.saturating_add(visible).min(body_lines.len());
    frame.render_widget(
        Paragraph::new(
            body_lines[scroll..end]
                .iter()
                .map(|line| approval_body_line(line))
                .collect::<Vec<_>>(),
        ),
        content_inner,
    );

    frame.render_widget(
        Paragraph::new(format!(
            "Lines {}-{} of {} · ↑/↓ one · PgUp/PgDn page",
            scroll.saturating_add(1).min(body_lines.len()),
            end.max(1),
            body_lines.len()
        ))
        .style(Style::default().fg(Color::DarkGray))
        .alignment(Alignment::Center),
        rows[3],
    );

    let (action, action_style, note) = if draft.submitted {
        (
            " Working… ",
            Style::default().fg(Color::Yellow),
            "Approval is durable; Esc closes this view.",
        )
    } else if !draft.approval_enabled {
        (
            " Approval unavailable ",
            Style::default().fg(Color::DarkGray),
            draft
                .blockers
                .first()
                .map(String::as_str)
                .unwrap_or("Required planning output is incomplete."),
        )
    } else {
        (
            " Approve run ",
            if draft.approve_focused {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::LightGreen)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::LightGreen)
            },
            if draft.approve_focused {
                "Enter approves and creates the integration branch."
            } else {
                "Tab focuses the approval action after review."
            },
        )
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    if draft.approve_focused {
                        "▸ ["
                    } else {
                        "  ["
                    },
                    action_style,
                ),
                Span::styled(action, action_style),
                Span::styled("]", action_style),
            ])
            .alignment(Alignment::Center),
            Line::styled(
                short(note, usize::from(rows[4].width)),
                Style::default().fg(if draft.approval_enabled {
                    Color::DarkGray
                } else {
                    Color::LightRed
                }),
            )
            .alignment(Alignment::Center),
        ]),
        rows[4],
    );
    frame.render_widget(
        Paragraph::new("←/→ sections · ↑/↓/Pg scroll · Tab action · r resume · Esc close")
            .style(Style::default().fg(Color::DarkGray))
            .alignment(Alignment::Center),
        rows[5],
    );
}

fn approval_wrapped_lines(body: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for source in body.lines() {
        if source.trim().is_empty() {
            lines.push(String::new());
        } else {
            lines.extend(wrap_full_text(source, width));
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn approval_body_line(line: &str) -> Line<'static> {
    let text = line.to_owned();
    if line.starts_with('#') {
        Line::styled(
            text,
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
    } else if line.trim_start().starts_with("Decision:") {
        Line::styled(text, Style::default().fg(Color::LightGreen))
    } else {
        Line::raw(text)
    }
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
    lines.extend(spacer());
    lines.push(Line::styled(
        "Close: h · Esc · Enter · q · F1",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(format!(" Help · {} ", content.title))
                    .title_alignment(Alignment::Center),
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
        || !run
            .summary
            .as_ref()
            .is_some_and(|summary| summary.status == "active")
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
    format!("{label} · showing {first}–{last} of {total_items} · ←/→ choose · Home/End")
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
    lines.extend([
        Line::styled(
            short(
                "Tab/↑/↓: move · ←/→: choose · Enter: continue · F5: create · Esc: cancel",
                usize::from(inner_width),
            ),
            Style::default().fg(Color::DarkGray),
        ),
        Line::styled(
            short(
                "Creates a standalone copy. Review it here; Ctrl-P validates and publishes later.",
                usize::from(inner_width),
            ),
            Style::default().fg(Color::Yellow),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" New run type · guided setup "),
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
    let prompt_rows = 1_u16.saturating_add(
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
    let base_height = 16_u16.saturating_add(gap.saturating_mul(4));
    let one_chip_row_height = base_height
        .saturating_add(prompt_rows)
        .saturating_add(stage_rows);
    let chip_rows = run_type_chip_layout(run_types, inner_width)
        .last()
        .map_or(1, |chip| chip.row + 1)
        .min(if one_chip_row_height >= 30 { 3 } else { 1 });
    let natural_height = base_height
        .saturating_add(prompt_rows)
        .saturating_add(chip_rows)
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
    u16::from(dialog_height >= 28)
}

fn new_run_prompt_row_height(index: usize) -> u16 {
    if index == 0 { 1 } else { 2 }
}

fn new_run_prompt_window(draft: &NewRunDraft, available_rows: u16) -> (usize, usize, u16) {
    let total = 1 + draft.intake_fields.len();
    let active = draft.active_field.min(total.saturating_sub(1));
    let available_rows = available_rows.max(new_run_prompt_row_height(active));
    let all_rows = (0..total).fold(0_u16, |rows, index| {
        rows.saturating_add(new_run_prompt_row_height(index))
    });
    if all_rows <= available_rows {
        return (0, total, all_rows);
    }
    let mut start = 0;
    loop {
        let mut end = start;
        let mut rows = 0_u16;
        while end < total {
            let height = new_run_prompt_row_height(end);
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
                    "{planning} · {} questions · {parallel}",
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
        (
            "Goal / work request".to_owned(),
            draft.goal.clone(),
            String::new(),
        ),
        ("Base ref".to_owned(), draft.base_ref.clone(), String::new()),
        (
            "Question policy".to_owned(),
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
                    "Details · showing {}–{} of {} · Tab/↑/↓ move",
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
                    "Planning agent is running… · Esc: close (the run remains durable)"
                } else if draft.active_field == 0 {
                    "←/→ or Home/End: select · click: choose · Enter: continue · Esc: cancel"
                } else {
                    "Enter: next/start planning · ←/→: configured choices · Esc: cancel"
                },
                usize::from(inner_width),
            ),
            Style::default().fg(Color::DarkGray),
        ),
        Line::styled(
            short(
                "A permanent branch is created only after plan approval.",
                usize::from(inner_width),
            ),
            Style::default().fg(Color::Yellow),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" New run · guided intake "),
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
    run_type: usize,
    questions: usize,
    parallel: usize,
    agents: usize,
    submit: usize,
}

fn new_run_control_indices(draft: &NewRunDraft) -> NewRunControlIndices {
    let run_type = 1 + draft.intake_fields.len();
    let questions = run_type + 1;
    let parallel = questions + 1;
    let agents = parallel + 1;
    NewRunControlIndices {
        run_type,
        questions,
        parallel,
        agents,
        submit: agents + NEW_RUN_AGENT_ROLES.len() * 2,
    }
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
                .fg(Color::Gray)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("─".repeat(right), Style::default().fg(Color::DarkGray)),
    ])
}

const QUESTION_POLICIES: [(&str, &str, Color); 3] = [
    ("autonomous", "no", Color::LightGreen),
    ("high_impact_only", "some", Color::Yellow),
    ("interactive", "many", Color::LightMagenta),
];

fn question_policy_chips(policy: &str, focused: bool) -> Line<'static> {
    let mut spans = vec![Span::styled(
        if focused { "▸ " } else { "  " },
        Style::default().fg(Color::Cyan),
    )];
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
    let mut start = 2_u16;
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
    let title_width = usize::from(width).saturating_sub(17).max(1);
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

fn visible_workflow_stage_lines(
    stages: &[Vec<Line<'static>>],
    capacity: usize,
) -> (Vec<Line<'static>>, usize) {
    let mut lines = Vec::new();
    let mut visible_stages = 0;
    for stage in stages {
        if lines.len().saturating_add(stage.len()) > capacity {
            if lines.is_empty() {
                lines.extend(stage.iter().take(capacity).cloned());
            }
            break;
        }
        lines.extend(stage.iter().cloned());
        visible_stages += 1;
    }
    (lines, visible_stages)
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
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{:<AGENT_MODEL_COLUMN_WIDTH$}", "Model"),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "Reasoning",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn stable_model_color(model: &str) -> Color {
    match model {
        "Codex default" => return Color::Gray,
        "gpt-5.5" => return Color::LightBlue,
        "gpt-5.6-sol" => return Color::LightGreen,
        "gpt-5.6-terra" => return Color::LightMagenta,
        "gpt-5.6-luna" => return Color::LightCyan,
        "gpt-5.4" => return Color::Yellow,
        "gpt-5.4-mini" => return Color::LightRed,
        "gpt-5.3-codex-spark" => return Color::Cyan,
        _ => {}
    }
    let hash = model.bytes().fold(2_166_136_261_usize, |hash, byte| {
        hash.wrapping_mul(16_777_619) ^ usize::from(byte)
    });
    // Dynamic catalogs can introduce models we did not know at compile time.
    // Derive a stable, readable true-color badge instead of collapsing them
    // into a small palette where unrelated models frequently look identical.
    let channel = |shift: usize| {
        let value = u8::try_from((hash >> shift) & 0xff).unwrap_or_default();
        96_u8.saturating_add(value % 144)
    };
    Color::Rgb(channel(0), channel(8), channel(16))
}

fn stable_reasoning_color(reasoning: &str) -> Color {
    match reasoning {
        "none" => Color::DarkGray,
        "minimal" => Color::Gray,
        "low" => Color::LightGreen,
        "medium" => Color::LightBlue,
        "high" => Color::Yellow,
        "xhigh" => Color::LightMagenta,
        "max" => Color::LightRed,
        "ultra" => Color::LightCyan,
        "Codex default" => Color::Gray,
        other => stable_model_color(other),
    }
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
    let stage_groups = workflow_stage_rows(run_types, &draft.run_type, width);
    let gap = new_run_section_gap(area.height);
    // At compact terminal sizes, preserve every interactive control and use
    // the remaining rows for the ordered stage preview. A taller terminal
    // naturally expands this window until every full stage title is shown.
    let prompt_total = 1 + draft.intake_fields.len();
    let active_prompt = draft.active_field.min(prompt_total.saturating_sub(1));
    let stage_capacity = usize::from(
        inner_height.saturating_sub(
            14_u16
                .saturating_add(gap.saturating_mul(4))
                .saturating_add(chip_rows)
                .saturating_add(new_run_prompt_row_height(active_prompt)),
        ),
    );
    let (visible_stage_lines, visible_stage_count) =
        visible_workflow_stage_lines(&stage_groups, stage_capacity);
    let fixed_rows = 14_u16
        .saturating_add(gap.saturating_mul(4))
        .saturating_add(chip_rows)
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX));
    let (prompt_start, prompt_end, _) =
        new_run_prompt_window(draft, inner_height.saturating_sub(fixed_rows));

    let mut lines = vec![section_divider("Goal Prompt", width)];
    for prompt_index in prompt_start..prompt_end {
        let focused = draft.active_field == prompt_index;
        if prompt_index == 0 {
            let input = if draft.goal.is_empty() {
                if focused {
                    "▸ ▏".to_owned()
                } else {
                    "  —".to_owned()
                }
            } else if focused {
                format!("▸ {}", draft.goal)
            } else {
                format!("  {}", draft.goal)
            };
            lines.push(Line::styled(
                short(&input, usize::from(width)),
                if focused {
                    Style::default().fg(Color::White).bg(Color::DarkGray)
                } else {
                    Style::default()
                },
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
    lines.push(Line::styled(
        selector_heading(
            "Run type",
            chips.iter().map(|chip| chip.index),
            run_types.len(),
            window,
        ),
        Style::default()
            .fg(if draft.active_field == indices.run_type {
                Color::Cyan
            } else {
                Color::DarkGray
            })
            .add_modifier(Modifier::BOLD),
    ));
    for row in 0..chip_rows {
        let mut spans = Vec::new();
        let mut cursor = 0_u16;
        for chip in chips.iter().filter(|chip| chip.row == row) {
            if chip.x > cursor {
                spans.push(Span::raw(" ".repeat(usize::from(chip.x - cursor))));
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
            cursor = chip.x.saturating_add(chip.width);
        }
        lines.push(Line::from(spans));
    }

    if gap > 0 {
        lines.push(Line::raw(""));
    }

    let stage_heading = if visible_stage_count < stage_groups.len() {
        format!(
            "Stages · showing 1–{} of {}",
            visible_stage_count.max(1),
            stage_groups.len()
        )
    } else {
        "Stages".to_owned()
    };
    lines.push(Line::styled(
        stage_heading,
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    ));
    lines.extend(visible_stage_lines);
    if gap > 0 {
        lines.push(Line::raw(""));
    }
    lines.push(Line::styled(
        "Questions",
        Style::default()
            .fg(if draft.active_field == indices.questions {
                Color::Cyan
            } else {
                Color::DarkGray
            })
            .add_modifier(Modifier::BOLD),
    ));
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
    lines.push(
        Line::styled(
            "Tab/↑/↓ move · ←/→ change · Enter activates selected control · Esc cancels",
            Style::default().fg(Color::DarkGray),
        )
        .alignment(Alignment::Center),
    );
    lines.truncate(usize::from(inner_height));
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" New run "),
            )
            .wrap(Wrap { trim: false }),
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
    let (chips, _) = run_type_chip_page(
        draft,
        &model.run_types,
        area.width.saturating_sub(2).max(1),
        area.height,
    );
    let chip_rows = chips.last().map_or(1, |chip| chip.row + 1);
    let inner_height = area.height.saturating_sub(2);
    let width = area.width.saturating_sub(2).max(1);
    let stage_groups = workflow_stage_rows(&model.run_types, &draft.run_type, width);
    let gap = new_run_section_gap(area.height);
    let prompt_total = 1 + draft.intake_fields.len();
    let active_prompt = draft.active_field.min(prompt_total.saturating_sub(1));
    let stage_capacity = usize::from(
        inner_height.saturating_sub(
            14_u16
                .saturating_add(gap.saturating_mul(4))
                .saturating_add(chip_rows)
                .saturating_add(new_run_prompt_row_height(active_prompt)),
        ),
    );
    let (visible_stage_lines, _) = visible_workflow_stage_lines(&stage_groups, stage_capacity);
    let fixed_rows = 14_u16
        .saturating_add(gap.saturating_mul(4))
        .saturating_add(chip_rows)
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX));
    let (prompt_start, prompt_end, prompt_rows) =
        new_run_prompt_window(draft, inner_height.saturating_sub(fixed_rows));
    let inner_y = area.y.saturating_add(1);
    let prompt_y = inner_y.saturating_add(1);
    let mut field_y = prompt_y;
    for index in prompt_start..prompt_end {
        let height = new_run_prompt_row_height(index);
        if row >= field_y && row < field_y.saturating_add(height) {
            return Some(NewRunHit::Field(index));
        }
        field_y = field_y.saturating_add(height);
    }
    let chip_y = inner_y.saturating_add(3).saturating_add(prompt_rows);
    if let Some(id) = chips.into_iter().find_map(|chip| {
        let x = area.x.saturating_add(1).saturating_add(chip.x);
        let y = chip_y.saturating_add(chip.row);
        (column >= x && column < x.saturating_add(chip.width) && row == y)
            .then(|| model.run_types[chip.index].id.clone())
    }) {
        return Some(NewRunHit::RunType(id));
    }
    let indices = new_run_control_indices(draft);
    let stage_y = chip_y
        .saturating_add(chip_rows)
        .saturating_add(gap)
        .saturating_add(1);
    let questions_heading_y = stage_y
        .saturating_add(u16::try_from(visible_stage_lines.len()).unwrap_or(u16::MAX))
        .saturating_add(gap);
    let questions_y = questions_heading_y.saturating_add(1);
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
    if row == questions_heading_y {
        return Some(NewRunHit::Field(indices.questions));
    }
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
    let submit_y =
        agents_y.saturating_add(u16::try_from(NEW_RUN_AGENT_ROLES.len()).unwrap_or(u16::MAX));
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
    lines.push(Line::raw(""));
    lines.extend(wrap_scalar_editor_text(
        "←/→ move · Home/End start/end · Backspace/Delete remove · type/paste insert at caret · Enter apply · Esc cancel",
        Style::default().fg(Color::DarkGray),
        width,
    ));
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
    let cursor = edit.cursor.min(edit.value.chars().count());
    let mut lines = Vec::new();
    let mut glyphs = Vec::new();
    let mut position = 0;
    for character in edit.value.chars() {
        if position == cursor {
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
    if position == cursor {
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
                compact_token_count(run.total_tokens)
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
            "no run selected · press n to start",
            Style::default().fg(Color::LightBlue),
        ));
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
                "◇ awaiting approval",
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
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(28),
            Constraint::Percentage(42),
            Constraint::Percentage(30),
        ])
        .split(area);
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
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
        .constraints([Constraint::Length(6), Constraint::Min(5)])
        .split(columns[2]);
    let (detail_switcher, _) = bordered_switcher_and_body(middle[0]);
    OperateLayout {
        runs: left[0],
        tickets: left[1],
        ticket_switcher,
        ticket_items,
        details: middle[0],
        detail_switcher,
        pending_questions: show_pending_questions.then_some(middle[1]),
        active_agents: right[0],
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
    let title = format!(" Questions · ‹ {position} › · Enter answer ");
    let block = panel_block(&title, model.focus == Focus::Questions);
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
        .take(2)
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
        lines.push(Line::styled(
            short(context, width),
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.push(Line::raw(""));
    if let Some(options) = question.get("options").and_then(Value::as_array) {
        for (index, option) in options.iter().enumerate() {
            let label = option
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or("Option");
            let description = option
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let recommended = option
                .get("recommended")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let badge = format!(" {} {} ", index + 1, label);
            let badge_width = UnicodeWidthStr::width(badge.as_str());
            let description = short(
                description,
                width.saturating_sub(badge_width).saturating_sub(2),
            );
            lines.push(Line::from(vec![
                Span::styled(
                    badge,
                    Style::default()
                        .fg(Color::Black)
                        .bg(if recommended {
                            Color::Cyan
                        } else {
                            Color::Gray
                        })
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw("  "),
                Span::styled(description, Style::default().fg(Color::DarkGray)),
            ]));
        }
    }
    if question_answer_is_pending_resume(question) {
        lines.push(Line::styled(
            "✓ Answer recorded · planning will resume after this batch is complete",
            Style::default().fg(Color::Green),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
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
    let count = model
        .selected_run_data()
        .map(|run| run.agent_summaries().len())
        .unwrap_or_default();
    let index = agent_first(model, inner, count) + usize::from(row.saturating_sub(inner.y));
    (index < count).then_some(index)
}

fn draw_active_agents(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let agents = model
        .selected_run_data()
        .map(RunData::agent_summaries)
        .unwrap_or_default();
    let active = agents.iter().filter(|agent| agent.live).count();
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    let first = agent_first(model, inner, agents.len());
    let end = first
        .saturating_add(usize::from(inner.height))
        .min(agents.len());
    let range =
        (agents.len() > usize::from(inner.height)).then(|| format!(" · {}–{}", first + 1, end));
    let title = format!(
        " Agents · {active} active / {}{} ",
        agents.len(),
        range.as_deref().unwrap_or_default()
    );
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
                    agent.title.clone(),
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
        colors[(model.activity_tick as usize / 2) % colors.len()]
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn draw_runs(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let block = panel_block(" Runs [n new] ", model.focus == Focus::Runs);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let controls_height = u16::from(!model.runs.is_empty());
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(controls_height)])
        .split(inner);
    let first = model
        .selected_run
        .saturating_sub(usize::from(rows[0].height / 2).saturating_sub(1));
    let items = if model.runs.is_empty() {
        vec![ListItem::new(Line::styled(
            "No runs — press n",
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
                            run.total_tokens,
                            run.validation_errors > 0,
                        )
                    })
                    .unwrap_or(("Unknown run", "unknown", "default", 0, 0, 0, 0, false));
                let live = agents > 0;
                let marker = if invalid {
                    "!"
                } else if live {
                    "⚙"
                } else {
                    status_glyph(status)
                };
                let marker_color = if invalid {
                    Color::LightRed
                } else if live {
                    Color::Green
                } else {
                    status_color(status)
                };
                let run_type = summary
                    .map(|summary| model.display_run_type_title(summary))
                    .unwrap_or_else(|| humanize(run_type));
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
                            compact_token_count(tokens),
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
            Paragraph::new(run_controls_hint(model, inner.width))
                .alignment(Alignment::Center)
                .style(Style::default().fg(Color::Cyan)),
            rows[1],
        );
    }
}

fn run_controls_hint(model: &ControlCenterModel, width: u16) -> String {
    let action = match model.selected_run_transition() {
        Some("pausing") => "Pausing…",
        Some("resuming") => "Resuming…",
        _ if !model.selected_run_running() => "Resume run",
        _ => "Pause run",
    };
    if width >= 31 {
        format!("Space {action} · D Delete run")
    } else if action.starts_with("Resume") {
        "Space play·D delete".to_owned()
    } else if action.starts_with("Pausing") {
        "Pausing…·D delete".to_owned()
    } else if action.starts_with("Resuming") {
        "Resuming…·D delete".to_owned()
    } else {
        "Space pause·D delete".to_owned()
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
    let scope = if model.selected_graph_is_ticket_projection() {
        "ticket checkout"
    } else {
        "integration"
    };
    let node_count = model.selected_graph_values().len();
    let title = format!(" Project graph · {scope} · {node_count} nodes ");
    let block = panel_block(&title, model.focus == Focus::Graph);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let nodes = model.selected_graph_values();
    let renderer = graph_renderer_for_options(
        std::env::var("TERM").as_deref() == Ok("dumb"),
        model
            .selected_run_data()
            .and_then(|run| run.graph_options.as_ref()),
    );
    let width = usize::from(inner.width.saturating_sub(1));
    let rendered = renderer.render_values(nodes, width);
    let lines = rendered
        .iter()
        .skip(model.graph_scroll)
        .take(usize::from(inner.height))
        .map(|line| graph_line(line))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), inner);
}

pub(crate) fn graph_renderer_for_options(ascii: bool, options: Option<&Value>) -> GraphRenderer {
    let mut renderer = GraphRenderer::new(ascii);
    if let Some(options) = options {
        let hierarchy = options
            .get("hierarchy")
            .or_else(|| options.get("layers"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        renderer = renderer.with_hierarchy(hierarchy);
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

fn graph_line(line: &crate::graph::GraphLine) -> Line<'static> {
    if line.node_spans.is_empty() {
        return Line::raw(line.text.clone());
    }
    let mut spans = Vec::new();
    let characters: Vec<_> = line.text.chars().collect();
    let mut cursor = 0;
    let mut node_spans = line.node_spans.clone();
    node_spans.sort_by_key(|span| span.start);
    for span in node_spans {
        let start = span.start.min(characters.len());
        let end = span.end.min(characters.len());
        if start < cursor || start >= end {
            continue;
        }
        if cursor < start {
            spans.push(Span::raw(
                characters[cursor..start].iter().collect::<String>(),
            ));
        }
        spans.push(Span::styled(
            characters[start..end].iter().collect::<String>(),
            Style::default()
                .fg(node_color(&span.node_type))
                .add_modifier(Modifier::BOLD),
        ));
        cursor = end;
    }
    if cursor < characters.len() {
        spans.push(Span::raw(characters[cursor..].iter().collect::<String>()));
    }
    Line::from(spans)
}

fn draw_details(frame: &mut Frame<'_>, model: &ControlCenterModel, area: Rect) {
    let title = format!(" Details [{}] ", model.detail_panel.label());
    let block = panel_block(&title, model.focus == Focus::Details);
    frame.render_widget(block, area);
    let (switcher, body) = bordered_switcher_and_body(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("‹ ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                humanize(model.detail_panel.label()),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" ›", Style::default().fg(Color::DarkGray)),
        ]))
        .alignment(Alignment::Center),
        switcher,
    );
    let lines = detail_lines(model);
    frame.render_widget(
        Paragraph::new(lines)
            .scroll((model.detail_scroll.min(u16::MAX as usize) as u16, 0))
            .wrap(Wrap { trim: false }),
        body,
    );
}

fn detail_lines(model: &ControlCenterModel) -> Text<'static> {
    let run = model.selected_run_data();
    match model.detail_panel {
        Panel::Overview => {
            let overview_subject = match model.focus {
                Focus::Runs => OverviewSubject::Run,
                Focus::Tickets => OverviewSubject::Ticket,
                _ => model.overview_subject,
            };
            if overview_subject == OverviewSubject::Run {
                return run_overview_details(model, run);
            }
            let Some(ticket) = model.selected_ticket_value() else {
                return run_overview_details(model, run);
            };
            let mut overview = metadata_text(ticket, run, model);
            if let Some(run) = run {
                overview.lines.extend([
                    Line::raw(""),
                    Line::styled("Run health & evidence", heading_style()),
                ]);
                overview
                    .lines
                    .extend(report_text(run, model.selected_graph_values().len(), model).lines);
            }
            overview
        }
        Panel::Planning => {
            let transcript = run
                .map(|run| run.planning_transcript.as_slice())
                .unwrap_or_default();
            if transcript.is_empty() {
                Text::from("No planning transcript for this run.")
            } else {
                narrative_cards(transcript)
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
                        format!(
                            "▶ Enter controls the current {} stage",
                            pipeline_stage_category(definition)
                        ),
                        Style::default()
                            .fg(Color::Black)
                            .bg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Line::styled(
                        "The compiler cursor chooses the stage; completed stages are never rerun.",
                        Style::default().fg(Color::DarkGray),
                    ),
                    Line::raw(""),
                ]);
            }
            text.lines
                .extend(pipeline_stage_cards(stages, run, model).lines);
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

fn run_overview_details(model: &ControlCenterModel, run: Option<&RunData>) -> Text<'static> {
    if let Some(errors) = run
        .and_then(|run| run.snapshot.get("validation_errors"))
        .and_then(Value::as_array)
        .filter(|errors| !errors.is_empty())
    {
        let mut lines = vec![Line::styled(
            format!(
                "! {} validation issue{}",
                errors.len(),
                plural(errors.len())
            ),
            Style::default()
                .fg(Color::LightRed)
                .add_modifier(Modifier::BOLD),
        )];
        lines.extend(errors.iter().map(|error| {
            let message = error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
                .unwrap_or("Configuration or project state is invalid");
            Line::raw(format!("  • {message}"))
        }));
        return Text::from(lines);
    }
    let mut overview = run
        .and_then(|run| run.summary.as_ref().map(|summary| (run, summary)))
        .map(|(run, summary)| {
            run_overview_text(run, summary, &model.display_run_type_title(summary), model)
        })
        .unwrap_or_else(|| Text::from("No run overview available."));
    if let Some(run) = run {
        overview.lines.extend([
            Line::raw(""),
            Line::styled("Health & evidence", heading_style()),
        ]);
        overview
            .lines
            .extend(report_text(run, run.graph.len(), model).lines);
    }
    overview
}

fn metadata_text(
    ticket: &Value,
    run: Option<&RunData>,
    model: &ControlCenterModel,
) -> Text<'static> {
    let status = ticket
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let operation = string_at(ticket, "operation");
    let progress = ticket_progress(ticket, run);
    let mut lines = vec![
        Line::styled(
            display_ticket_title(ticket),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Line::from(vec![
            Span::styled(
                format!(" {} {} ", status_glyph(status), humanize(status)),
                Style::default()
                    .fg(Color::Black)
                    .bg(status_color(status))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(humanize(&operation), Style::default().fg(Color::LightBlue)),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Workflow  ", heading_style()),
            Span::styled(
                format!("{}/{} complete", progress.done, progress.states.len()),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(workflow_rail_spans(&progress.states, &progress.glyphs)),
    ];
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
    if let Some(scope) = ticket.get("scope") {
        let read_nodes = value_len(scope.get("read_nodes"));
        let write_nodes = value_len(scope.get("write_nodes"));
        let read_paths = value_len(scope.get("read_paths"));
        let write_paths = value_len(scope.get("write_paths"));
        lines.extend([
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
        ]);
    }
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
        lines.push(Line::from(vec![
            Span::styled(
                format!("{connector}─"),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(
                format!("{} ", progress.glyphs.for_state(state)),
                Style::default().fg(step_color(state)),
            ),
            Span::styled(humanize(&id), Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(
                format!("  {}", step_label(state)),
                Style::default().fg(step_color(state)),
            ),
        ]));
        let persona = string_at(step, "persona");
        let prefix = if index + 1 == workflow.len() {
            "   "
        } else {
            "│  "
        };
        lines.push(Line::styled(
            format!("{prefix}{}", humanize(&persona)),
            Style::default().fg(Color::LightBlue),
        ));
        if let Some(output) = outputs
            .iter()
            .find(|output| string_at(output, "step_id") == id)
        {
            let findings = value_len(output.get("findings"));
            let risks = value_len(output.get("risks"));
            let files =
                value_len(output.get("files_written")) + value_len(output.get("files_deleted"));
            lines.push(Line::styled(
                format!("{prefix}{findings} findings · {risks} risks · {files} files changed"),
                Style::default().fg(Color::DarkGray),
            ));
        } else if let Some(expected) = step
            .get("expected_outputs")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
        {
            lines.push(Line::styled(
                format!("{prefix}expects {}", short(expected, 62)),
                Style::default().fg(Color::DarkGray),
            ));
        }
    }
    let blocker_count = value_len(ticket.get("blockers"));
    if blocker_count > 0 {
        lines.extend([
            Line::raw(""),
            Line::styled(
                format!(
                    "! {blocker_count} blocker{} need attention",
                    plural(blocker_count)
                ),
                Style::default().fg(Color::LightRed),
            ),
        ]);
    }
    if let Some(run) = run {
        let ticket_id = string_at(ticket, "id");
        let recent = run
            .events
            .iter()
            .filter(|event| string_at(event, "ticket_id") == ticket_id)
            .rev()
            .take(4)
            .collect::<Vec<_>>();
        if !recent.is_empty() {
            lines.extend([
                Line::raw(""),
                Line::styled("Recent activity", heading_style()),
            ]);
            for event in recent {
                lines.push(Line::raw(format!(
                    "  • {}",
                    humanize(
                        event
                            .get("event_type")
                            .or_else(|| event.get("type"))
                            .and_then(Value::as_str)
                            .unwrap_or("activity")
                    )
                )));
            }
        }
    }
    Text::from(lines)
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
                || (compiled.is_none() && closed)
            {
                StepVisualState::Done
            } else if active_step == Some(id) {
                StepVisualState::Active
            } else if failed_step == Some(id) {
                StepVisualState::Failed
            } else if ready.contains(&id) || (compiled.is_none() && index == 0) {
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
    let lines = vec![
        Line::from(vec![
            Span::styled(
                format!(
                    " {} {} ",
                    status_glyph(&summary.status),
                    humanize(&summary.status)
                ),
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
        Line::styled(
            summary.goal.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
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
    Text::from(lines)
}

fn narrative_cards(items: &[Value]) -> Text<'static> {
    let mut lines = Vec::new();
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
        let (title, body, color) = planning_event_projection(item);
        lines.push(Line::from(vec![
            Span::styled("● ", Style::default().fg(color)),
            Span::styled(title, heading_style()),
        ]));
        if let Some(body) = body.filter(|body| !body.trim().is_empty()) {
            lines.push(Line::styled(body, Style::default().fg(Color::Gray)));
        }
        lines.push(Line::raw(""));
    }
    Text::from(lines)
}

/// Turn the nested Codex JSONL stream into operator-facing activity. The durable transcript keeps
/// the exact event; this projection deliberately names what happened instead of repeating the
/// transport envelope (`planning.agent.event`) for every row.
fn planning_event_projection(item: &Value) -> (String, Option<String>, Color) {
    let event_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let stage = item
        .get("stage_id")
        .and_then(Value::as_str)
        .map(humanize)
        .unwrap_or_else(|| "Planning".to_owned());
    match event_type {
        "planning.intake" => (
            "Goal and run settings captured".to_owned(),
            item.get("intake")
                .and_then(|intake| intake.get("question_policy"))
                .and_then(Value::as_str)
                .map(|policy| format!("Question policy · {}", humanize(policy))),
            Color::Cyan,
        ),
        "planning.compiler_stage.completed" => (
            format!("{stage} validated"),
            Some("Compiler checks passed and the workflow advanced.".to_owned()),
            Color::Green,
        ),
        "planning.agent.starting" => (
            format!("{stage} started"),
            Some("The planning agent is reading the project and shaping this pass.".to_owned()),
            Color::Yellow,
        ),
        "planning.agent.resuming" => (
            format!("{stage} resumed"),
            Some("Recorded answers were returned to the same planning session.".to_owned()),
            Color::Yellow,
        ),
        "planning.agent.completed" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            (
                format!("{stage} {}", humanize(status)),
                Some("The pass reached a durable boundary.".to_owned()),
                if status == "succeeded" {
                    Color::Green
                } else {
                    Color::LightRed
                },
            )
        }
        "planning.question.opened" => (
            "Clarification requested".to_owned(),
            item.get("request")
                .and_then(|request| request.get("prompt"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            Color::Yellow,
        ),
        "planning.question.resumed" => (
            "Answer returned to planning".to_owned(),
            Some(format!("{stage} can continue with the recorded decision.")),
            Color::Green,
        ),
        "planning.output" => {
            let output = item.get("output").unwrap_or(&Value::Null);
            let body = ["summary", "content", "message", "text", "plan"]
                .into_iter()
                .find_map(|field| output.get(field).and_then(Value::as_str))
                .or_else(|| output.as_str())
                .map(|body| short(body, 220));
            (format!("{stage} plan recorded"), body, Color::Green)
        }
        "planning.agent.event" => project_nested_planning_event(item, &stage),
        other => {
            let body = ["content", "message", "summary", "text", "prompt"]
                .into_iter()
                .find_map(|field| item.get(field).and_then(Value::as_str))
                .map(|body| short(body, 220));
            (
                if other.is_empty() {
                    "Planning update".to_owned()
                } else {
                    humanize(other)
                },
                body,
                Color::Cyan,
            )
        }
    }
}

fn project_nested_planning_event(item: &Value, stage: &str) -> (String, Option<String>, Color) {
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
        ("thread.started", _) => (
            format!("{stage} session connected"),
            Some("A new planning conversation is ready.".to_owned()),
            Color::Cyan,
        ),
        ("turn.started", _) => (
            format!("{stage} reasoning"),
            Some("The agent is considering the project context.".to_owned()),
            Color::Yellow,
        ),
        ("turn.completed", _) => {
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
            (
                format!("{stage} reasoning complete"),
                (total > 0).then(|| format!("{} used in this turn.", compact_token_count(total))),
                Color::Green,
            )
        }
        ("item.started", "command_execution") => (
            "Inspecting the project".to_owned(),
            nested
                .get("command")
                .and_then(Value::as_str)
                .map(|command| short_command(command, 180)),
            Color::Yellow,
        ),
        ("item.completed", "command_execution") => {
            let exit = nested.get("exit_code").and_then(Value::as_i64);
            (
                if exit == Some(0) {
                    "Project inspection completed".to_owned()
                } else {
                    "Project inspection needs attention".to_owned()
                },
                nested
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| short_command(command, 180)),
                if exit == Some(0) {
                    Color::Green
                } else {
                    Color::LightRed
                },
            )
        }
        ("item.completed", "agent_message") => (
            "Agent shared its reasoning".to_owned(),
            nested
                .get("text")
                .and_then(Value::as_str)
                .map(planning_agent_message_summary),
            Color::Cyan,
        ),
        _ => (
            format!(
                "{stage} · {}",
                humanize(if nested_type.is_empty() {
                    event_type
                } else {
                    nested_type
                })
            ),
            nested
                .get("text")
                .and_then(Value::as_str)
                .map(|text| short(text, 220)),
            Color::Cyan,
        ),
    }
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

fn short_command(command: &str, width: usize) -> String {
    let command = command
        .strip_prefix("/bin/zsh -lc ")
        .or_else(|| command.strip_prefix("/bin/bash -lc "))
        .unwrap_or(command)
        .trim_matches('"');
    short(command, width)
}

fn report_text(
    run: &RunData,
    visible_graph_nodes: usize,
    model: &ControlCenterModel,
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
    let failed_workers = run
        .tickets
        .iter()
        .filter(|ticket| ticket_progress(ticket, Some(run)).worker_failed)
        .count();
    let board = run.snapshot.get("board");
    let failed_actions = board.map_or(0, |board| value_len(board.get("failed_journals")));
    let interrupted_actions = board.map_or(0, |board| value_len(board.get("incomplete_journals")));
    let interrupted_integrations =
        board.map_or(0, |board| value_len(board.get("incomplete_integrations")));
    let healthy = summary.validation_errors == 0
        && blocked == 0
        && failed_workers == 0
        && failed_actions == 0
        && interrupted_actions == 0
        && interrupted_integrations == 0;
    let health_color = if healthy {
        Color::Green
    } else {
        Color::LightRed
    };
    let lines = vec![
        Line::from(vec![
            Span::styled(
                if healthy {
                    " ● HEALTHY "
                } else {
                    " ! ATTENTION "
                },
                Style::default()
                    .fg(Color::Black)
                    .bg(health_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {}", humanize(&summary.status)),
                Style::default().fg(status_color(&summary.status)),
            ),
        ]),
        Line::raw(""),
        Line::styled("Tickets", heading_style()),
        Line::raw(format!("● {closed} complete")),
        Line::raw(format!("◐ {active} active")),
        Line::raw(format!("○ {todo} waiting")),
        Line::styled(
            format!("! {blocked} blocked"),
            Style::default().fg(if blocked > 0 {
                Color::LightRed
            } else {
                Color::DarkGray
            }),
        ),
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
        Line::styled(
            format!(
                "! {failed_workers} worker{} need recovery",
                plural(failed_workers)
            ),
            Style::default().fg(if failed_workers > 0 {
                Color::LightRed
            } else {
                Color::DarkGray
            }),
        ),
        Line::styled(
            format!("! {failed_actions} failed action{}", plural(failed_actions)),
            Style::default().fg(if failed_actions > 0 {
                Color::LightRed
            } else {
                Color::DarkGray
            }),
        ),
        Line::styled(
            format!(
                "! {interrupted_actions} interrupted action{} · {interrupted_integrations} integration{}",
                plural(interrupted_actions),
                plural(interrupted_integrations)
            ),
            Style::default().fg(if interrupted_actions > 0 || interrupted_integrations > 0 {
                Color::Yellow
            } else {
                Color::DarkGray
            }),
        ),
        Line::raw(format!("◇ {visible_graph_nodes} graph nodes")),
        Line::raw(format!(
            "? {} open question{}",
            summary.open_questions,
            plural(summary.open_questions)
        )),
        Line::styled(
            format!(
                "{} {} validation issue{}",
                if summary.validation_errors == 0 {
                    "✓"
                } else {
                    "!"
                },
                summary.validation_errors,
                plural(summary.validation_errors)
            ),
            Style::default().fg(if summary.validation_errors == 0 {
                Color::Green
            } else {
                Color::LightRed
            }),
        ),
        Line::raw(""),
        Line::styled(
            if run.report.is_some() {
                "Configured report is ready when the run reaches its reporting stage."
            } else {
                "No final report has been produced yet."
            },
            Style::default().fg(Color::DarkGray),
        ),
    ];
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
    let edited_documents = model
        .config
        .documents
        .iter()
        .filter(|document| document.dirty() || document.is_new)
        .count();
    let file_operations = model.config.pending_deletes.len() + model.config.pending_renames.len();
    let changes = edited_documents + file_operations;
    let issues = model
        .config
        .documents
        .iter()
        .map(|document| document.diagnostics.len())
        .sum::<usize>()
        + usize::from(model.catalog_error.is_some());
    let (marker, state, color) = if issues > 0 {
        (
            "!",
            format!("{issues} issue{} block publication", plural(issues)),
            Color::LightRed,
        )
    } else if changes > 0 {
        (
            "●",
            format!("{changes} staged change{}", plural(changes)),
            Color::Yellow,
        )
    } else {
        ("✓", "published configuration".to_owned(), Color::Green)
    };
    let primary_action = if model.legacy_migration_available {
        "T New run type · L Migrate Legacy"
    } else {
        "T New run type"
    };
    if area.width < 110 {
        let compact_state = if issues > 0 {
            format!("{marker} {issues} issue{}", plural(issues))
        } else if changes > 0 {
            format!("{marker} {changes} draft{}", plural(changes))
        } else {
            format!("{marker} published")
        };
        let compact_action = if model.legacy_migration_available {
            "T run type · L migrate"
        } else {
            "T run type"
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(compact_state, Style::default().fg(color)),
                Span::styled(" · future runs · ", Style::default().fg(Color::LightBlue)),
                Span::styled("Ctrl-P publish", Style::default().fg(Color::Cyan)),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled("Ctrl-S save", Style::default().fg(Color::Cyan)),
                Span::styled(
                    format!(" · {compact_action}"),
                    Style::default().fg(Color::DarkGray),
                ),
            ]))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Draft workspace "),
            ),
            area,
        );
        return;
    }
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(format!("{marker} {state}"), Style::default().fg(color)),
            Span::styled(
                "  ·  Future runs only  ·  ",
                Style::default().fg(Color::LightBlue),
            ),
            Span::styled(primary_action, Style::default().fg(Color::Cyan)),
            Span::styled(
                "  ·  Ctrl-S save all · Ctrl-P validate & publish",
                Style::default().fg(Color::DarkGray),
            ),
        ]))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Draft workspace "),
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
                let state_suffix = if compact {
                    String::new()
                } else {
                    format!("  {state_label}")
                };
                let fixed_width = 6 + UnicodeWidthStr::width(state_suffix.as_str());
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
                    Line::from(vec![
                        Span::styled(
                            if selected { "▸ " } else { "  " },
                            Style::default().fg(Color::Cyan),
                        ),
                        Span::styled(
                            if ends_group { "└─" } else { "├─" },
                            Style::default().fg(config_domain_color(domain)),
                        ),
                        Span::styled(format!("{state} "), Style::default().fg(state_color)),
                        Span::styled(
                            title,
                            Style::default().add_modifier(if selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                        ),
                        Span::styled(state_suffix, Style::default().fg(state_color)),
                    ]),
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
                    "Choose a resource to edit its guided fields.",
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
    let state_suffix = format!("  {state_label}");
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
            "Intake, run pipelines, questions, and orchestration for future runs."
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
    if model.config_document_deleted(primary) {
        ("×", "delete staged", Color::LightRed)
    } else if documents
        .iter()
        .any(|document| !document.diagnostics.is_empty())
    {
        ("!", "needs repair", Color::LightRed)
    } else if documents.iter().any(|document| {
        document.dirty() || document.is_new || model.config_document_deleted(document)
    }) || renamed
    {
        ("●", "draft", Color::Yellow)
    } else {
        ("✓", "published", Color::Green)
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
        let diagnostic = if !document.diagnostics.is_empty() {
            document.diagnostics.join("\n")
        } else if let Some(error) = &model.catalog_error {
            format!("semantic validation: {error}")
        } else {
            if document.dirty() {
                "syntax valid · draft saved separately from live configuration".to_owned()
            } else {
                "syntax valid · published source".to_owned()
            }
        };
        let valid = document.diagnostics.is_empty() && model.catalog_error.is_none();
        frame.render_widget(
            Paragraph::new(diagnostic)
                .style(Style::default().fg(if valid { Color::Green } else { Color::LightRed }))
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
        || !run
            .summary
            .as_ref()
            .is_some_and(|summary| summary.status == "active")
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
            "{} · Space pause/play · D delete · n new · j/k select · Enter open · Tab focus · q quit",
            focus_key_label(model, "1", "Runs")
        ),
        (Mode::Operate, Focus::Tickets) => format!(
            "{} · j/k select · [/] queue · a actions · Tab focus · Space pause · r refresh",
            focus_key_label(model, "2", "Tickets")
        ),
        (Mode::Operate, Focus::Graph) => format!(
            "{} · j/k or PgUp/PgDn scroll · Tab focus · c configure · r refresh",
            focus_key_label(model, "5", "Graph")
        ),
        (Mode::Operate, Focus::Agents) => format!(
            "{} · j/k or PgUp/PgDn scroll · wheel anywhere over Agents · Tab focus · r refresh",
            focus_key_label(model, "4", "Agents")
        ),
        (Mode::Operate, Focus::Questions) => {
            "Questions · ←/→ switch · Enter/? answer · R auto-resolve · Tab focus · r refresh"
                .to_owned()
        }
        (Mode::Operate, Focus::Details) if model.detail_panel == crate::model::Panel::Stages => {
            format!(
                "{} · Enter control current stage · [/] view · j/k scroll · Tab focus · r refresh",
                focus_key_label(model, "3", "Details")
            )
        }
        (Mode::Operate, Focus::Details) => format!(
            "{} · [/] view · j/k scroll · a actions · Tab focus · r refresh",
            focus_key_label(model, "3", "Details")
        ),
        (Mode::Operate, _) => "Tab focus · r refresh · c configure · q quit".to_owned(),
        (Mode::Configure, Focus::Yaml)
            if model.config.linked_document_editor_active()
                || model
                    .config
                    .selected_resource()
                    .is_some_and(ConfigResource::is_raw_source) =>
        {
            "Source editor · type to edit · Esc resources · Ctrl-S save all · Ctrl-P validate & publish".to_owned()
        }
        (Mode::Configure, Focus::Yaml) => {
            "Guided editor · j/k setting · Enter edit · Esc resources · Ctrl-S save all · Ctrl-P validate & publish · c operate".to_owned()
        }
        (Mode::Configure, Focus::ConfigTree) => {
            "Domains · j/k choose · Enter resources · Tab focus · Ctrl-S save all · Ctrl-P validate & publish".to_owned()
        }
        (Mode::Configure, Focus::ConfigForm)
            if model.config.selected_domain() == ConfigDomain::Advanced =>
        {
            "Resources · j/k choose · Enter open · N new source · M rename · D delete · Tab focus · c operate".to_owned()
        }
        (Mode::Configure, Focus::ConfigForm) => {
            let create = if model.config.selected_domain() == ConfigDomain::RunTypes {
                if model.legacy_migration_available {
                    " · T new run type · L migrate Legacy"
                } else {
                    " · T new run type"
                }
            } else {
                ""
            };
            format!(
                "Resources · j/k choose · Enter open{create} · Tab focus · Ctrl-P validate & publish"
            )
        }
        (Mode::Configure, _) => {
            "Tab focus · Ctrl-S save all · Ctrl-P validate & publish · c operate".to_owned()
        }
    };
    let help_key = if config_source_help_uses_f1(model) {
        "F1 help"
    } else {
        "h help"
    };
    let width = usize::from(area.width);
    if model.mode == Mode::Configure && area.width < 110 {
        let focus = match model.focus {
            Focus::ConfigTree => "Domains j/k · Enter open",
            Focus::ConfigForm => "Resources j/k · Enter open",
            Focus::Yaml
                if model.config.linked_document_editor_active()
                    || model
                        .config
                        .selected_resource()
                        .is_some_and(ConfigResource::is_raw_source) =>
            {
                "Source edit · Esc back"
            }
            Focus::Yaml => "Fields j/k · Enter edit · Esc back",
            _ => "Tab focus",
        };
        let mut compact = format!(" {help_key} · Ctrl-P publish · Ctrl-S save · {focus}");
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
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", if live { "⚙" } else { status_glyph(status) }),
                if live {
                    live_activity_style(model)
                } else {
                    Style::default()
                        .fg(status_color(status))
                        .add_modifier(Modifier::BOLD)
                },
            ),
            Span::styled(
                title.to_owned(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    "  {}",
                    if live {
                        "Working".to_owned()
                    } else {
                        humanize(status)
                    }
                ),
                if live {
                    live_activity_style(model)
                } else {
                    Style::default().fg(status_color(status))
                },
            ),
        ]));
        lines.push(Line::styled(
            format!("  {}", pipeline_stage_category(definition)),
            Style::default().fg(Color::DarkGray),
        ));
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
    const PALETTE: [Color; 7] = [
        Color::LightMagenta,
        Color::LightBlue,
        Color::LightCyan,
        Color::Yellow,
        Color::LightRed,
        Color::Green,
        Color::LightGreen,
    ];
    let hash = node_type.bytes().fold(0_usize, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(usize::from(byte))
    });
    PALETTE[hash % PALETTE.len()]
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
        assert!(rendered.contains("Goal Prompt"), "{rendered}");
        assert!(rendered.contains("Run Config"), "{rendered}");
        assert!(rendered.contains("Questions"), "{rendered}");
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
        let stages = row_containing("Stages");
        let last_stage = row_containing("Compile report");
        let questions = row_containing("Questions");
        let question_chips = row_containing("some");
        let parallel = row_containing("Max parallel agents");
        let agents = row_containing("Agent");

        assert!(
            stages >= run_type + 3,
            "run_type={run_type}, stages={stages}, area={area:?}"
        );
        assert!(questions >= last_stage + 2);
        assert!(parallel >= question_chips + 2);
        assert!(agents >= parallel + 2);
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
            Some(NewRunHit::Field(4))
        );
        assert_eq!(
            new_run_hit_at(&model, reasoning_position.0, reasoning_position.1, size),
            Some(NewRunHit::Field(5))
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
        assert!(rendered.contains("Goal Prompt"), "{rendered}");
        assert!(rendered.contains("Run Config"), "{rendered}");
        assert!(rendered.contains("Constraint 12 *"), "{rendered}");
        assert!(rendered.contains("Configured value 12"), "{rendered}");
        assert!(!rendered.contains("Constraint 01"), "{rendered}");
        assert!(rendered.contains("Start Planning"), "{rendered}");
        assert!(
            rendered.contains("Enter activates selected control"),
            "{rendered}"
        );
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
        assert!(rendered.contains("Ctrl-P validates and publishes later"));
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
    fn configure_mode_advertises_run_type_and_legacy_migration_actions() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/project".into(), json!(null));
        model.mode = Mode::Configure;
        model.focus = Focus::ConfigTree;
        model.legacy_migration_available = true;
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("New run type"), "{rendered}");
        assert!(rendered.contains("Migrate Legacy"), "{rendered}");
        assert!(rendered.contains("T New run type"), "{rendered}");
        assert!(rendered.contains("L Migrate Legacy"), "{rendered}");
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
    }

    #[test]
    fn runs_panel_shows_each_runs_total_token_usage() {
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
                "output_tokens": 50_000,
                "total_tokens": 1_050_000
            },
            "tickets": [],
            "graph": []
        });
        let model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        let backend = TestBackend::new(120, 32);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);

        assert!(rendered.contains("1.1M tks"), "{rendered}");
        let runs = operate_layout(Rect::new(0, 4, 120, 27)).runs;
        assert!(
            (runs.y..runs.bottom()).any(|row| rendered_row(&terminal, row).contains("1.1M tks")),
            "token badge was clipped outside Runs {runs:?}: {rendered}"
        );
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
        assert!(rendered.contains("Details [overview]"));
        assert!(rendered.contains("/tmp/project"));
        assert!(!rendered.contains("Ticket checkout is ready"));
        let details = rendered_cell_position(&terminal, "Details [overview]").unwrap();
        let agents = rendered_cell_position(&terminal, "Agents").unwrap();
        let graph = rendered_cell_position(&terminal, "Project graph").unwrap();
        assert_eq!(details.1, agents.1);
        assert!(agents.1 < graph.1, "agents={agents:?}, graph={graph:?}");
        assert!(details.0 < graph.0, "details={details:?}, graph={graph:?}");
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
                    "output":{"output":{"output":verification}}
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
            "Review planning and approve",
            "Decisions",
            "Architecture",
            "Risks",
            "Verification",
            "Resolved decisions",
            "How should invalid inputs",
            "Decision: Raise TypeError",
            "Approve run",
            "Tab focuses",
        ] {
            assert!(
                compact_text.contains(visible),
                "missing {visible}: {compact_text}"
            );
        }
        assert!(
            !compact_text.contains("Structured planner output"),
            "{compact_text}"
        );

        let mut roomy_model = ControlCenterModel::from_snapshot("/tmp/project".into(), snapshot);
        roomy_model.open_selected_run_approval();
        let expected = [
            (0, "How should invalid inputs be rejected?"),
            (1, "Architecture contract body"),
            (2, "Risk controls body"),
            (3, "Verification evidence line 1"),
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
        approval.selected_section = 3;
        approval.scroll = 16;
        let scrolled_backend = TestBackend::new(140, 36);
        let mut scrolled = Terminal::new(scrolled_backend).unwrap();
        scrolled.draw(|frame| draw(frame, &roomy_model)).unwrap();
        let scrolled_text = rendered_text(&scrolled);
        assert!(
            scrolled_text.contains("Verification evidence line 30"),
            "{scrolled_text}"
        );
        assert!(
            scrolled_text.contains("Lines 13-32 of 32"),
            "{scrolled_text}"
        );

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
        approval.approve_focused = true;
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let rendered = rendered_text(&terminal);
        assert!(rendered.contains("Approval unavailable"), "{rendered}");
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
        assert!(quiet.active_agents.y < quiet.graph.y);
        assert!(quiet.graph.height > 0);

        let pending = operate_layout_with_questions(area, true);
        let questions = pending.pending_questions.unwrap();
        assert_eq!(pending.details.x, questions.x);
        assert_eq!(pending.details.width, questions.width);
        assert_eq!(pending.details.height + questions.height, area.height);
        assert!(pending.details.height > questions.height);
        assert_eq!(pending.graph, quiet.graph);
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
            assert!(
                rendered.contains(&format!("Details [{}]", panel.label())),
                "{rendered}"
            );
            assert!(rendered.contains("Questions · ‹"), "{rendered}");
            assert!(!rendered.contains("Details [questions]"), "{rendered}");
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
        assert!(pending.contains("Questions · ‹"), "{pending}");
        assert!(pending.contains("Choose storage"), "{pending}");
        assert!(pending.contains("Project graph"), "{pending}");

        model.runs[model.selected_run].questions.clear();
        model.normalize_conditional_focus();
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let settled = rendered_text(&terminal);
        assert_eq!(model.focus, Focus::Details);
        assert!(!settled.contains("Questions · ‹"), "{settled}");
        assert!(!settled.contains("Choose storage"), "{settled}");
        assert!(settled.contains("Details [overview]"), "{settled}");
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

        assert!(rendered.contains("Agents · 1 active / 2"), "{rendered}");
        assert!(rendered.contains("Plan risk controls"), "{rendered}");
        assert!(rendered.contains("Reviewer"), "{rendered}");
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(rendered_cell_position(&terminal, "Plan risk controls").unwrap())
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
        assert!(rendered.contains("Questions · ‹"), "{rendered}");
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
        assert!(compact_text.contains("1 / 3"), "{compact_text}");
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
        assert!(second.contains("2 / 3"), "{second}");
        assert!(second.contains("Choose element policy"), "{second}");
        assert!(second.contains("✓ Answer recorded"), "{second}");
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
            ("1 / 3", "Choose rejection behavior"),
            ("2 / 3", "Choose element policy"),
            ("3 / 3", "Choose corpus boundary"),
        ] {
            roomy.draw(|frame| draw(frame, &roomy_model)).unwrap();
            let text = rendered_text(&roomy);
            assert!(text.contains(position), "missing {position}: {text}");
            assert!(text.contains(prompt), "missing {prompt}: {text}");
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
        assert!(rendered.contains("Custom"), "{rendered}");
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
                    {"id":"live-agent-secret","stage_id":"live-stage-secret","status":"running","updated_at":"2026-07-11T12:06:00Z"},
                    {"id":"old-agent-a-secret","stage_id":"old-stage-a-secret","status":"completed","updated_at":"2026-07-11T12:05:00Z"},
                    {"id":"old-agent-b-secret","stage_id":"old-stage-b-secret","status":"completed","updated_at":"2026-07-11T12:04:00Z"},
                    {"id":"old-agent-c-secret","stage_id":"old-stage-c-secret","status":"completed","updated_at":"2026-07-11T12:03:00Z"},
                    {"id":"old-agent-d-secret","stage_id":"old-stage-d-secret","status":"completed","updated_at":"2026-07-11T12:02:00Z"},
                    {"id":"old-agent-e-secret","stage_id":"old-stage-e-secret","status":"completed","updated_at":"2026-07-11T12:01:00Z"}
                ]
            }),
        );
        model.focus = Focus::Agents;
        let backend = TestBackend::new(82, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let first = rendered_text(&terminal);
        assert!(first.contains("Agents · 1 active / 6"), "{first}");
        assert!(first.contains("Build note editor"), "{first}");
        assert!(!first.contains("Map app structure"), "{first}");

        model.selected_agent = 5;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let scrolled = rendered_text(&terminal);
        assert!(scrolled.contains("Map app structure"), "{scrolled}");
        assert_eq!(
            terminal
                .backend()
                .buffer()
                .cell(rendered_cell_position(&terminal, "Map app structure").unwrap())
                .unwrap()
                .fg,
            Color::DarkGray
        );
        for secret in ["live-agent-secret", "old-agent", "stage-secret"] {
            assert!(!scrolled.contains(secret), "leaked {secret}: {scrolled}");
        }
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
            (Focus::Details, "3 Details"),
            (Focus::Questions, "Questions"),
            (Focus::Agents, "4 Agents"),
            (Focus::Graph, "5 Graph"),
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
        assert!(rendered.contains("Goal Prompt"), "{rendered}");
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

        assert!(
            rendered.matches("Original Research Sprint").count() >= 3,
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
            assert!(header.contains("0/0 tickets · 0 tks"), "{header}");
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
        assert!(header.contains("· 0 tks"), "{header}");
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
        assert!(rendered.contains("Draft workspace"), "{rendered}");
        assert!(rendered.contains("Future runs only"), "{rendered}");
        assert!(rendered.contains("Guided editor"), "{rendered}");
        assert!(!rendered.contains("Project graph"), "{rendered}");
        assert!(!rendered.contains("[task]"), "{rendered}");
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
        assert!(rendered.contains("Ctrl-S save"), "{rendered}");
        assert!(rendered.contains("Reasoning"), "{rendered}");
        assert!(rendered.contains("Workers · Arch"), "{rendered}");
        assert!(rendered.contains("Workers · Chan"), "{rendered}");
        assert!(
            rendered.contains('…'),
            "compact identities need an explicit ellipsis: {rendered}"
        );
        assert!(rendered.contains("published"), "{rendered}");
        assert!(!rendered.contains("publishedpublished"), "{rendered}");
        assert_eq!(header_height, 7);
        assert_eq!(
            configure_field_at(&model, editor.x + 1, editor.y + 1 + header_height, content,),
            Some(0)
        );
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
        assert!(run_types.contains("Run behavior and intake"), "{run_types}");
        assert!(run_types.contains("Guided editor"), "{run_types}");
        assert!(!run_types.contains("run-types/medium.yaml"), "{run_types}");
        assert!(!run_types.contains("Project graph"), "{run_types}");

        model
            .config
            .select_domain_index(ConfigDomain::Agents.index());
        model.focus = Focus::ConfigForm;
        terminal.draw(|frame| draw(frame, &model)).unwrap();
        let agents = rendered_text(&terminal);
        for role in ["Planner", "Lead", "Workers", "Reviewer"] {
            assert!(agents.contains(role), "missing {role}: {agents}");
        }

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

        assert_eq!(config_resource_state(&model, &resource).1, "published",);
        model
            .config
            .documents
            .iter_mut()
            .find(|document| document.relative_path == Path::new("prompts/reviewer.md"))
            .unwrap()
            .text
            .push_str("Check current proof.\n");
        assert_eq!(config_resource_state(&model, &resource).1, "draft");
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
            assert!(rendered.contains("type/paste insert"), "{rendered}");
            assert!(rendered.contains("at caret · Enter apply"), "{rendered}");
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
    fn planning_transcript_names_nested_activity_instead_of_repeating_transport_events() {
        let text = narrative_cards(&[
            json!({
                "type":"planning.agent.event",
                "stage_id":"architecture-plan",
                "event":{"type":"item.started","item":{
                    "type":"command_execution",
                    "command":"/bin/zsh -lc \"git status --short\""
                }}
            }),
            json!({
                "type":"planning.agent.event",
                "stage_id":"architecture-plan",
                "event":{"type":"item.completed","item":{
                    "type":"agent_message",
                    "text":"{\"questions\":[{\"prompt\":\"Which storage boundary should notes use?\"}]}"
                }}
            }),
            json!({
                "type":"planning.question.opened",
                "request":{"prompt":"This durable question must not become history UI"}
            }),
        ]);
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

        assert!(rendered.contains("Inspecting the project"), "{rendered}");
        assert!(rendered.contains("git status --short"), "{rendered}");
        assert!(rendered.contains("Planning paused for input"), "{rendered}");
        assert!(!rendered.contains("Which storage boundary"), "{rendered}");
        assert!(!rendered.contains("durable question"), "{rendered}");
        assert!(!rendered.contains("Planning agent event"), "{rendered}");
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
            rendered.contains("Enter controls the current Human decision stage"),
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

        let text = detail_lines(&model);
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
        assert!(rendered.contains("2 graph nodes"), "{rendered}");
        assert!(!rendered.contains("internal-journal-id"), "{rendered}");
    }

    #[test]
    fn overview_preserves_the_last_run_or_ticket_subject_when_details_receives_focus() {
        let snapshot = json!({
            "run":{
                "id":"run-secret",
                "goal":"Run-level delivery goal",
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
            detail_lines(model)
                .lines
                .iter()
                .flat_map(|line| line.spans.iter())
                .map(|span| span.content.as_ref())
                .collect::<Vec<_>>()
                .join("\n")
        };

        model.focus_runs();
        model.focus = Focus::Details;
        let run_overview = rendered(&model);
        assert!(
            run_overview.contains("Run-level delivery goal"),
            "{run_overview}"
        );
        assert!(
            !run_overview.contains("Ticket-level implementation"),
            "{run_overview}"
        );

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
        let details = rendered_cell_position(&terminal, "Details [overview]").unwrap();
        let graph = rendered_cell_position(&terminal, "Project graph").unwrap();
        assert!(details.0 < graph.0, "details={details:?}, graph={graph:?}");
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
