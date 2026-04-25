#include "mlab/CommandBridge.hpp"
#include "mlab/BridgeConstants.h"

#include <cstdio>
#include <cstring>
#include <string>

#include <nlohmann/json.hpp>

#if defined(_WIN32)
#include <windows.h>
#else
#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace mlab::host {

namespace {

#if defined(_WIN32)

static bool write_all(HANDLE h, char const* data, std::size_t n) {
  std::size_t off = 0;
  while (off < n) {
    DWORD w = 0;
    if (!WriteFile(h, data + off, static_cast<DWORD>(n - off), &w, nullptr) || w == 0) {
      return false;
    }
    off += w;
  }
  return true;
}

static bool read_line(HANDLE h, std::string& out) {
  out.clear();
  char ch{};
  DWORD n = 0;
  for (;;) {
    if (!ReadFile(h, &ch, 1, &n, nullptr) || n == 0) {
      return false;
    }
    if (ch == '\n') {
      break;
    }
    if (ch != '\r') {
      out += ch;
    }
  }
  return true;
}

static void send_msg(HANDLE h, std::string const& s) {
  std::string line = s;
  line += '\n';
  (void)write_all(h, line.data(), line.size());
}

#else

static bool write_all_fd(int fd, char const* data, std::size_t n) {
  std::size_t off = 0;
  while (off < n) {
    ssize_t w = ::write(fd, data + off, n - off);
    if (w <= 0) {
      return false;
    }
    off += static_cast<std::size_t>(w);
  }
  return true;
}

static bool read_line_fd(int fd, std::string& out) {
  out.clear();
  char ch{};
  for (;;) {
    ssize_t n = ::read(fd, &ch, 1);
    if (n <= 0) {
      return false;
    }
    if (ch == '\n') {
      break;
    }
    if (ch != '\r') {
      out += ch;
    }
  }
  return true;
}

static void send_msg_fd(int fd, std::string const& s) {
  std::string line = s;
  line += '\n';
  (void)write_all_fd(fd, line.data(), line.size());
}

#endif

static void trim_cmd(std::string& s) {
  while (!s.empty() && s.back() == ' ') {
    s.pop_back();
  }
  while (!s.empty() && s.front() == ' ') {
    s.erase(0, 1);
  }
}

static bool starts_with(std::string const& s, char const* p) {
  std::size_t const n = std::strlen(p);
  return s.size() >= n && s.compare(0, n, p) == 0;
}

}  // namespace

int run_command_bridge(mlab::host::HostState& state, std::string& out_error) {
  out_error.clear();

#if defined(_WIN32)
  HANDLE hPipe = CreateNamedPipeA(mlab::bridge::kDefaultPipeName, PIPE_ACCESS_DUPLEX,
                                  PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, nullptr);
  if (hPipe == INVALID_HANDLE_VALUE) {
    out_error = "CreateNamedPipe failed";
    return 1;
  }
  (void)std::fprintf(
      stdout,
      "otl_marketlab_host: named pipe is open. Waiting for the UI to connect (blocks here until Electron or another client "
      "connects)…\n");
  (void)std::fflush(stdout);
  if (!ConnectNamedPipe(hPipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) {
    out_error = "ConnectNamedPipe failed";
    CloseHandle(hPipe);
    return 1;
  }
  for (;;) {
    std::string line;
    if (!read_line(hPipe, line)) {
      break;
    }
    trim_cmd(line);
    if (line == "PING") {
      send_msg(hPipe, R"raw(OK {"event":"PING","bridge":"CommandBridge v1"})raw");
    } else if (line == "QUIT" || line == "EXIT") {
      send_msg(hPipe, R"raw(OK {"event":"QUIT"})raw");
      break;
    } else if (starts_with(line, "LOAD_DATA ")) {
      std::string path = line.substr(10);
      trim_cmd(path);
      std::string e;
      if (state.load_data(path, e)) {
        send_msg(hPipe, std::string("OK ") + state.load_data_json());
      } else {
        nlohmann::json jerr;
        jerr["error"] = e;
        send_msg(hPipe, std::string("ERR ") + jerr.dump());
      }
    } else if (starts_with(line, "SEEK ")) {
      std::string t = line.substr(5);
      trim_cmd(t);
      send_msg(hPipe, std::string("OK ") + state.seek_json(t));
    } else if (starts_with(line, "SET_UBER_SIGNAL ")) {
      std::string json = line.substr(16);
      trim_cmd(json);
      std::string e;
      if (state.set_uber_signal_json(std::move(json), e)) {
        nlohmann::json j;
        j["ok"]              = true;
        j["uber_config_set"] = true;
        send_msg(hPipe, std::string("OK ") + j.dump());
      } else {
        nlohmann::json jerr;
        jerr["ok"]    = false;
        jerr["error"] = e.empty() ? "set_uber_signal failed" : e;
        send_msg(hPipe, std::string("ERR ") + jerr.dump());
      }
    } else if (line.empty()) {
      continue;
    } else {
      send_msg(hPipe, R"raw(ERR {"error":"unknown command"})raw");
    }
  }
  FlushFileBuffers(hPipe);
  CloseHandle(hPipe);
  return 0;

#else
  int const lfd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (lfd < 0) {
    out_error = "socket(AF_UNIX) failed";
    return 1;
  }
  struct sockaddr_un addr {};
  addr.sun_family = AF_UNIX;
  (void)std::strncpy(addr.sun_path, mlab::bridge::kDefaultSocketPath, sizeof(addr.sun_path) - 1);
  (void)::unlink(addr.sun_path);
  if (bind(lfd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    out_error = "bind failed";
    ::close(lfd);
    return 1;
  }
  if (listen(lfd, 1) < 0) {
    out_error = "listen failed";
    ::close(lfd);
    return 1;
  }
  (void)std::fprintf(
      stdout,
      "otl_marketlab_host: socket listening on %s. Waiting for the UI to connect…\n", mlab::bridge::kDefaultSocketPath);
  (void)std::fflush(stdout);
  int cfd = accept(lfd, nullptr, nullptr);
  if (cfd < 0) {
    out_error = "accept failed";
    ::close(lfd);
    return 1;
  }
  ::close(lfd);
  for (;;) {
    std::string line;
    if (!read_line_fd(cfd, line)) {
      break;
    }
    trim_cmd(line);
    if (line == "PING") {
      send_msg_fd(cfd, R"raw(OK {"event":"PING","bridge":"CommandBridge v1"})raw");
    } else if (line == "QUIT" || line == "EXIT") {
      send_msg_fd(cfd, R"raw(OK {"event":"QUIT"})raw");
      break;
    } else if (starts_with(line, "LOAD_DATA ")) {
      std::string path = line.substr(10);
      trim_cmd(path);
      std::string e;
      if (state.load_data(path, e)) {
        send_msg_fd(cfd, std::string("OK ") + state.load_data_json());
      } else {
        nlohmann::json jerr;
        jerr["error"] = e;
        send_msg_fd(cfd, std::string("ERR ") + jerr.dump());
      }
    } else if (starts_with(line, "SEEK ")) {
      std::string t = line.substr(5);
      trim_cmd(t);
      send_msg_fd(cfd, std::string("OK ") + state.seek_json(t));
    } else if (starts_with(line, "SET_UBER_SIGNAL ")) {
      std::string json = line.substr(16);
      trim_cmd(json);
      std::string e;
      if (state.set_uber_signal_json(std::move(json), e)) {
        nlohmann::json j;
        j["ok"]              = true;
        j["uber_config_set"] = true;
        send_msg_fd(cfd, std::string("OK ") + j.dump());
      } else {
        nlohmann::json jerr;
        jerr["ok"]    = false;
        jerr["error"] = e.empty() ? "set_uber_signal failed" : e;
        send_msg_fd(cfd, std::string("ERR ") + jerr.dump());
      }
    } else if (line.empty()) {
      continue;
    } else {
      send_msg_fd(cfd, R"raw(ERR {"error":"unknown command"})raw");
    }
  }
  ::close(cfd);
  (void)::unlink(addr.sun_path);
  return 0;
#endif
}

}  // namespace mlab::host
