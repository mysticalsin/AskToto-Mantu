/*
 * supervise.exe: run one command inside a private Windows job object that no descendant can leave.
 *
 * Contract:   supervise.exe [--] <exe> [args...]
 *   - The child inherits stdin/stdout/stderr and the environment.
 *   - The job has JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and never JOB_OBJECT_LIMIT_BREAKAWAY_OK or
 *     SILENT_BREAKAWAY_OK, so when supervise.exe dies for any reason (including TerminateProcess) the
 *     kernel kills the child and every descendant.
 *   - The child is placed in the job atomically at creation through PROC_THREAD_ATTRIBUTE_JOB_LIST, so
 *     it can never run outside the job, even briefly.
 *   - Exit code: the child's exit code; 125 when supervise.exe itself cannot set up or start the child.
 *
 * Built and used only when the HK-W lane (scripts/qa/hk-w.ps1) measures descendants surviving a hard
 * kill of Metis.exe. See README.md.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static int fail(const wchar_t *what) {
  fwprintf(stderr, L"supervise: %ls failed (%lu)\n", what, GetLastError());
  return 125;
}

/* Everything after the optional "--", as one command line, using the original quoting. */
static wchar_t *child_command_line(void) {
  wchar_t *line = GetCommandLineW();
  int quoted = 0;
  /* Skip our own argv[0]. */
  while (*line && (quoted || (*line != L' ' && *line != L'\t'))) {
    if (*line == L'"') quoted = !quoted;
    line++;
  }
  while (*line == L' ' || *line == L'\t') line++;
  if (line[0] == L'-' && line[1] == L'-' && (line[2] == L' ' || line[2] == L'\t')) {
    line += 2;
    while (*line == L' ' || *line == L'\t') line++;
  }
  return line;
}

int wmain(void) {
  wchar_t *command = child_command_line();
  if (!*command) {
    fwprintf(stderr, L"usage: supervise.exe [--] <exe> [args...]\n");
    return 125;
  }

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return fail(L"CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    return fail(L"SetInformationJobObject");
  }

  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
  if (!attrs || !InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize)) return fail(L"InitializeProcThreadAttributeList");
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {
    return fail(L"UpdateProcThreadAttribute");
  }

  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attrs;

  /* CreateProcessW may modify its command-line buffer, so it needs a writable copy. */
  size_t length = wcslen(command) + 1;
  wchar_t *mutableLine = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, length * sizeof(wchar_t));
  if (!mutableLine) return fail(L"HeapAlloc");
  memcpy(mutableLine, command, length * sizeof(wchar_t));

  PROCESS_INFORMATION child;
  if (!CreateProcessW(NULL, mutableLine, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &child)) {
    return fail(L"CreateProcess");
  }
  CloseHandle(child.hThread);

  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD code = 125;
  GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess);
  CloseHandle(job); /* KILL_ON_JOB_CLOSE reaps any descendant that outlived the child. */
  return (int)code;
}
