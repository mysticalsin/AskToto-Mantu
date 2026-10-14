#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int write_pid_file(const WCHAR *path) {
  FILE *file = NULL;
  if (_wfopen_s(&file, path, L"wt, ccs=UTF-8") != 0 || file == NULL) return 0;
  int ok = fwprintf(file, L"%lu\n", GetCurrentProcessId()) > 0;
  return fclose(file) == 0 && ok;
}

int wmain(int argc, WCHAR **argv) {
  if (argc == 3 && wcscmp(argv[1], L"child") == 0) {
    if (!write_pid_file(argv[2])) return 10;
    Sleep(INFINITE);
    return 0;
  }
  if (argc != 3 || wcscmp(argv[1], L"root") != 0) return 11;

  WCHAR childMarker[MAX_PATH];
  if (_snwprintf_s(childMarker, MAX_PATH, _TRUNCATE, L"%ls\\child.pid", argv[2]) < 0) return 12;
  WCHAR executable[MAX_PATH];
  DWORD exeLength = GetModuleFileNameW(NULL, executable, MAX_PATH);
  if (exeLength == 0 || exeLength >= MAX_PATH) return 13;
  WCHAR commandLine[MAX_PATH * 3];
  if (_snwprintf_s(commandLine, MAX_PATH * 3, _TRUNCATE, L"\"%ls\" child \"%ls\"", executable, childMarker) < 0) return 14;

  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&child, sizeof(child));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(executable, commandLine, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup, &child)) return 15;
  CloseHandle(child.hThread);
  WCHAR rootMarker[MAX_PATH];
  if (_snwprintf_s(rootMarker, MAX_PATH, _TRUNCATE, L"%ls\\root.pid", argv[2]) < 0 ||
      !write_pid_file(rootMarker)) {
    TerminateProcess(child.hProcess, 16);
    CloseHandle(child.hProcess);
    return 16;
  }
  CloseHandle(child.hProcess);
  Sleep(INFINITE);
  return 0;
}
