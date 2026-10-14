/*
 * osroots.exe: return Windows' own system-directory answers as one bounded JSON line.
 *
 * This helper is read-only. It does not read SystemRoot, PATH, the current directory, or any
 * caller-provided path. The packaged x64 binary calls the Windows directory APIs directly.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define ROOT_CAPACITY 260
#define JSON_CAPACITY 2048

typedef UINT (WINAPI *directory_fn)(LPWSTR, UINT);

static int emit_error(const char *code) {
  char line[128];
  int length = snprintf(line, sizeof(line), "{\"version\":1,\"error\":\"%s\"}\n", code);
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (length <= 0 || length >= (int)sizeof(line) || output == INVALID_HANDLE_VALUE ||
      !WriteFile(output, line, (DWORD)length, &written, NULL) || written != (DWORD)length) {
    return 3;
  }
  return 2;
}

static int is_drive_rooted(const WCHAR *path) {
  WCHAR drive = path[0];
  return ((drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z')) &&
         path[1] == L':' && path[2] == L'\\';
}

static int valid_canonical_directory(const WCHAR *path) {
  WCHAR canonical[ROOT_CAPACITY];
  DWORD length = (DWORD)wcslen(path);
  if (length < 4 || length >= ROOT_CAPACITY || !is_drive_rooted(path)) return 0;

  /* Reject ambiguous spellings and unsafe path components before comparing canonical form. */
  for (DWORD i = 0; i < length; i++) {
    WCHAR ch = path[i];
    if (ch < 0x20 || ch == 0x7f || ch == L'/' || ch == L';' || ch == L'"' || ch == L'%') return 0;
    if (ch == L'\\' && i + 1 < length && path[i + 1] == L'\\') return 0;
  }
  if (path[length - 1] == L'\\') return 0;

  DWORD canonicalLength = GetFullPathNameW(path, ROOT_CAPACITY, canonical, NULL);
  if (canonicalLength == 0 || canonicalLength >= ROOT_CAPACITY) return 0;
  if (CompareStringOrdinal(path, -1, canonical, -1, TRUE) != CSTR_EQUAL) return 0;

  /* No component may be a traversal alias, even if the API accepted the spelling. */
  const WCHAR *component = path + 3;
  const WCHAR *end = path + length;
  for (const WCHAR *cursor = component; cursor <= end; cursor++) {
    if (*cursor == L'\\' || cursor == end) {
      size_t componentLength = (size_t)(cursor - component);
      if (componentLength == 0 || (componentLength == 1 && component[0] == L'.') ||
          (componentLength == 2 && component[0] == L'.' && component[1] == L'.')) return 0;
      if (cursor == end) break;
      component = cursor + 1;
    }
  }
  return 1;
}

static int append_json_string(char *out, size_t capacity, size_t *used, const WCHAR *value) {
  char utf8[ROOT_CAPACITY * 4];
  int utf8Length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, utf8,
                                       (int)sizeof(utf8), NULL, NULL);
  if (utf8Length <= 0 || (size_t)utf8Length > sizeof(utf8)) return 0;
  utf8Length--; /* omit the terminating NUL */
  if (*used + 2 >= capacity) return 0;
  out[(*used)++] = '"';
  for (int i = 0; i < utf8Length; i++) {
    unsigned char ch = (unsigned char)utf8[i];
    if (ch == '"' || ch == '\\') {
      if (*used + 2 >= capacity) return 0;
      out[(*used)++] = '\\';
      out[(*used)++] = (char)ch;
    } else if (ch < 0x20) {
      if (*used + 6 >= capacity) return 0;
      int count = snprintf(out + *used, capacity - *used, "\\u%04x", (unsigned int)ch);
      if (count != 6) return 0;
      *used += 6;
    } else {
      if (*used + 1 >= capacity) return 0;
      out[(*used)++] = (char)ch;
    }
  }
  if (*used + 1 >= capacity) return 0;
  out[(*used)++] = '"';
  return 1;
}

static int emit_success(const WCHAR *windowsRoot, const WCHAR *systemRoot) {
  char line[JSON_CAPACITY];
  size_t used = 0;
  const char prefix[] = "{\"version\":1,\"windowsRoot\":";
  const char middle[] = ",\"systemRoot\":";
  if (sizeof(prefix) - 1 >= sizeof(line)) return emit_error("OUTPUT_FAILED");
  memcpy(line, prefix, sizeof(prefix) - 1);
  used = sizeof(prefix) - 1;
  if (!append_json_string(line, sizeof(line), &used, windowsRoot) ||
      sizeof(middle) - 1 > sizeof(line) - used) return emit_error("OUTPUT_FAILED");
  memcpy(line + used, middle, sizeof(middle) - 1);
  used += sizeof(middle) - 1;
  if (!append_json_string(line, sizeof(line), &used, systemRoot) || used + 3 > sizeof(line)) {
    return emit_error("OUTPUT_FAILED");
  }
  line[used++] = '}';
  line[used++] = '\n';
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == INVALID_HANDLE_VALUE || !WriteFile(output, line, (DWORD)used, &written, NULL) ||
      written != (DWORD)used) return 3;
  return 0;
}

int wmain(int argc, WCHAR **argv) {
  if (argc != 2 || wcscmp(argv[1], L"--json") != 0) return emit_error("ARGUMENTS_INVALID");

  WCHAR windowsRoot[ROOT_CAPACITY];
  WCHAR systemRoot[ROOT_CAPACITY];
  UINT windowsLength = GetSystemWindowsDirectoryW(windowsRoot, ROOT_CAPACITY);
  UINT systemLength = GetSystemDirectoryW(systemRoot, ROOT_CAPACITY);
  if (windowsLength == 0 || windowsLength >= ROOT_CAPACITY || systemLength == 0 ||
      systemLength >= ROOT_CAPACITY) return emit_error("OS_DIRECTORY_QUERY_FAILED");
  if (!valid_canonical_directory(windowsRoot) || !valid_canonical_directory(systemRoot)) {
    return emit_error("OS_DIRECTORY_INVALID");
  }

  WCHAR expectedSystemRoot[ROOT_CAPACITY];
  int expectedLength = _snwprintf_s(expectedSystemRoot, ROOT_CAPACITY, _TRUNCATE, L"%ls\\System32", windowsRoot);
  if (expectedLength < 0 || CompareStringOrdinal(expectedSystemRoot, -1, systemRoot, -1, TRUE) != CSTR_EQUAL) {
    return emit_error("SYSTEM_DIRECTORY_MISMATCH");
  }
  return emit_success(windowsRoot, systemRoot);
}
