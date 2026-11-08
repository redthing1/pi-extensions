# Ask User

Ask a set of questions in one interactive form.

## Usage

```ts
ask_user({
  questions: [{
    question: "Which approach should we use?",
    label: "Approach",
    options: [{ label: "Small change" }, { label: "Full rewrite" }]
  }]
})
```

A form accepts up to six questions and eight choices per question. Free text is
always available. `label` names the question's tab; option descriptions are optional.

Choose with arrows and Enter or a number. **Type something** opens free text;
Ctrl+E qualifies a choice. Tab and Shift+Tab move between tabs. The Submit tab
reviews the batch before sending it. Escape backs out of editing, then cancels.
**Chat about this** closes the form and returns the discussion to the conversation.

## Keybindings

In `keybindings.json`, remap `extension.askUser.previous`,
`extension.askUser.next`, and `extension.askUser.edit`. Their defaults are
Shift+Tab, Tab, and Ctrl+E.

The tool requires the TUI and waits for a submission or cancellation. Drafts stay
in memory; tool cancellation and session shutdown close the form.
