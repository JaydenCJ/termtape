# vhs script to record docs/assets demo as a GIF (https://github.com/charmbracelet/vhs)
# Usage: vhs docs/assets/demo.tape
# Kept in the repo so the demo is reproducible. The committed demo.svg shows
# the same session, captured from a real run in an environment without vhs.

Output docs/assets/demo.gif
Set FontSize 16
Set Width 1200
Set Height 600
Set Theme "GitHub Dark"
Set TypingSpeed 40ms

Type "termtape record -- curl -sS http://127.0.0.1:5432/health"
Enter
Sleep 1.5s

Type 'termtape search "port 5432"'
Enter
Sleep 2s

Type 'echo "export API_TOKEN=hunter2secret99" | termtape redact'
Enter
Sleep 2s

Type "termtape mcp   # agents can now search your terminal history over MCP"
Sleep 2.5s
