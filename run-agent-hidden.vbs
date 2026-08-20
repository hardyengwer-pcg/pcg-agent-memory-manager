Option Explicit

Dim shell, fso, root, args, i, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

command = "cmd.exe /d /c " & Chr(34) & Chr(34) & root & "\run-agent.cmd" & args & Chr(34)
shell.Run command, 0, True
