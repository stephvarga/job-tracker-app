# Developer Setup Tips

Personal shell and git setup, not required to run this project. Kept here so
it's easy to copy onto a new laptop.

## Git Aliases

Speed up your git workflow by adding these aliases to your `~/.gitconfig`:

```ini
[alias]
	st = status
	co = checkout
	br = branch
	psho = push origin
	pro = pull --rebase origin
	a = add .
```

Now instead of typing `git status` you type `git st`, `git push origin HEAD`
becomes `git psho`, etc.

## Colorized Terminal Prompt with Git Branch

Add this to your `~/.zshrc` to get a color-coded prompt that shows your current
folder and git branch:

```bash
# Git branch in prompt
git_branch() {
  git symbolic-ref --short HEAD 2>/dev/null
}

# Colors
autoload -U colors && colors

rainbow_path() {
  local parts=("${(@s:/:)${(%):-%3~}}")
  local colors=(197 208 227 48 51 213)
  local out=""
  for i in {1..${#parts}}; do
    out+="%F{${colors[$i]}}${parts[$i]}"
    [[ $i -lt ${#parts} ]] && out+="/"
  done
  echo -n "$out"
}

setopt PROMPT_SUBST
PROMPT='$(rainbow_path)%{$reset_color%} %F{48}$(git_branch)%{$reset_color%} %F{197}❯%F{208}❯%F{227}❯%{$reset_color%} '
```

Your prompt will look like:

```
~/Developer/shop-timer main ❯❯❯
```

Then reload your terminal config:

```bash
source ~/.zshrc
```
