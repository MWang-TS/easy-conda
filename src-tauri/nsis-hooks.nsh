; Easy Conda — NSIS installer hooks.
;
; The NSIS installer copies easy-conda.exe over the existing file. If an
; instance is still running, Windows refuses the write and the user sees:
;   "Error opening file for writing: ...\Easy Conda\easy-conda.exe"
; Tauri's built-in CheckIfAppIsRunning does not always manage to close a
; running instance (e.g. when it is not responding, or when a third-party
; HIPS/anti-virus keeps a handle on the image). Force-terminate it first.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing any running ${PRODUCTNAME} instance..."
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ; Give Windows a moment to release the image section before overwriting.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing any running ${PRODUCTNAME} instance..."
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  Sleep 500
!macroend
