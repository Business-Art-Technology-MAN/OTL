#include "mlab/BridgeConstants.h"
#include "mlab/CommandBridge.hpp"
#include "mlab/HostState.hpp"

#include <cstdio>
#include <string>

#if defined(_WIN32)
#include <windows.h>
#endif

static void print_banner_and_flush() {
#if defined(_WIN32)
  if (GetConsoleWindow() == nullptr) {
    if (AllocConsole()) {
      (void)freopen("CONOUT$", "w", stdout);
      (void)freopen("CONOUT$", "w", stderr);
    }
  }
#endif
  // Line-buffering can hide the first line before a blocking Connect/accept; force visibility.
  (void)setvbuf(stdout, nullptr, _IONBF, 0);
  (void)setvbuf(stderr, nullptr, _IONBF, 0);
#if defined(_WIN32)
  std::printf("otl_marketlab_host: named pipe: %s\n", mlab::bridge::kDefaultPipeName);
#else
  std::printf("otl_marketlab_host: UDS: %s\n", mlab::bridge::kDefaultSocketPath);
#endif
  std::printf("otl_marketlab_host: open Market Lab (Electron) in another terminal: npm start in OTL-MarketLab/electron\n");
  std::fflush(stdout);
  std::fflush(stderr);
}

int main() {
  print_banner_and_flush();
  mlab::host::HostState state;
  std::string            err;
  int const              rc = mlab::host::run_command_bridge(state, err);
  if (rc != 0) {
    if (!err.empty()) {
      std::fprintf(stderr, "otl_marketlab_host: %s\n", err.c_str());
    } else {
      std::fprintf(stderr, "otl_marketlab_host: exiting with code %d\n", rc);
    }
    std::fflush(stderr);
  } else {
    std::printf("otl_marketlab_host: client disconnected, exiting.\n");
    std::fflush(stdout);
  }
  return rc;
}
