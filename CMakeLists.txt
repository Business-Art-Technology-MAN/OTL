# OTL_Suite: OSL (C++) + VectorTA (Rust/cxx) + OTL-Core.
# Configure from the repo root, out-of-source, e.g.:
#   cmake -B build -S . -G "Ninja" -DCMAKE_TOOLCHAIN_FILE=.../vcpkg.cmake
#   cmake --build build

cmake_minimum_required(VERSION 3.20)
cmake_policy(SET CMP0077 NEW)

# vcpkg: only set a default if the user did not pass -DCMAKE_TOOLCHAIN_FILE on the command line.
if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  set(_otl_vcpkg "C:/Users/joeff/vcpkg/scripts/buildsystems/vcpkg.cmake")
  if(EXISTS "${_otl_vcpkg}")
    set(CMAKE_TOOLCHAIN_FILE "${_otl_vcpkg}" CACHE FILEPATH "vcpkg CMake toolchain" FORCE)
  else()
    message(
      NOTICE
      "vcpkg toolchain not found at ${_otl_vcpkg}. Set CMAKE_TOOLCHAIN_FILE to your vcpkg.cmake."
    )
  endif()
endif()

project(OTL_Suite LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Corrosion: prefer an install (CMAKE_PREFIX_PATH / package managers); else fetch a pinned release.
find_package(Corrosion QUIET CONFIG)
if(NOT Corrosion_FOUND)
  include(FetchContent)
  FetchContent_Declare(
    Corrosion
    GIT_REPOSITORY https://github.com/corrosion-rs/corrosion.git
    GIT_TAG v0.5.2
  )
  FetchContent_MakeAvailable(Corrosion)
endif()

# OSL: expects LLVM, OpenImath, OpenImageIO, pugixml, robin-map, partio, etc. via vcpkg / your prefix.
# Build options are controlled from 3rdparty/osl/CMakeCache when you reconfigure the top build.
if(EXISTS "${CMAKE_SOURCE_DIR}/3rdparty/osl/CMakeLists.txt")
  add_subdirectory(3rdparty/osl)
else()
  message(FATAL_ERROR "Expected 3rdparty/osl/CMakeLists.txt (OSL submodule) — missing.")
endif()

# vector-ta: enable cxx bridge; crate also emits a staticlib for Corrosion.
corrosion_import_crate(
  MANIFEST_PATH "${CMAKE_SOURCE_DIR}/3rdparty/VectorTA/Cargo.toml"
  FEATURES cxx-bridge
)

# C++ side of cxx: generates bridge headers/sources and a small static library to link.
# Paths are relative to the crate’s `src/` (Corrosion sets rust_source = MANIFEST_PATH/src/FILES).
# Only CRATE + FILES (Corrosion 0.5.2). Extra keywords are misparsed as extra inputs under FILES.
corrosion_add_cxxbridge(
  otl_vector_ta_cxx
  CRATE vector_ta
  FILES
    bridge.rs
)

# C++ support library from the `cxx` crate (Str/Vec/Slice) — not pulled in by Corrosion 0.5.
file(GLOB _OTL_CXX_GLOB
  "$ENV{USERPROFILE}/.cargo/registry/src/*/cxx-1.0.*/src/cxx.cc"
  "$ENV{CARGO_HOME}/registry/src/*/cxx-1.0.*/src/cxx.cc"
)
if(NOT _OTL_CXX_GLOB)
  message(
    FATAL_ERROR
    "Could not find cxx-1.0.*/src/cxx.cc under cargo (build 3rdparty/VectorTA once, or set CARGO_HOME)."
  )
endif()
list(GET _OTL_CXX_GLOB 0 _OTL_CXX_CC)
get_filename_component(_OTL_CXX_SRC_DIR "${_OTL_CXX_CC}" DIRECTORY)     # .../src
get_filename_component(_OTL_CXX_ROOT "${_OTL_CXX_SRC_DIR}" DIRECTORY)  # .../cxx-1.0.x
add_library(otl_cxx_crate_cpp STATIC "${_OTL_CXX_ROOT}/src/cxx.cc")
target_include_directories(otl_cxx_crate_cpp PUBLIC "${_OTL_CXX_ROOT}/include")
target_link_libraries(otl_vector_ta_cxx PUBLIC otl_cxx_crate_cpp)

# 1. GAL (header-only): point at the GAL 'include' or 'src' tree (repo-relative).
include_directories(3rdparty/gal/include)

# Project naming: "VectorTA-rust" in docs = Corrosion cxx target (Rust + generated C++ from bridge.rs).
# CMake target names must not use '-'; this alias is the link surface for the Rust/VectorTA stack.
add_library(VectorTA_rust ALIAS otl_vector_ta_cxx)

# nlohmann/json: OtlNodeSystem (M3) JSON config (must be before otl_core target_link_libraries).
include(FetchContent)
if(NOT TARGET nlohmann_json::nlohmann_json)
  FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
  )
  FetchContent_MakeAvailable(nlohmann_json)
endif()

# OTL-Core static library: shared by OTL_Engine, OTL_Sandbox, and keeps link flags in one place.
add_library(
  otl_core
  STATIC
  OTL-Core/otl/OtlUniverse.cpp
  OTL-Core/otl/VectorTAService.cpp
  OTL-Core/otl/MarketDelegate.cpp
  OTL-Core/otl/RegisterOtlM1Closures.cpp
  OTL-Core/otl/GaPortfolioIntegrator.cpp
  OTL-Core/otl/ExtractFixSignal.cpp
  OTL-Core/otl/OtlGeometricMetrics.cpp
  OTL-Core/otl/OtlAnalytics.cpp
  OTL-Core/otl/MarketDataCsv.cpp
  OTL-Core/otl/OtlNodeSystem.cpp
)
target_include_directories(otl_core
  PUBLIC
    "${CMAKE_SOURCE_DIR}/OTL-Core"
    # OSL headers (oslexec’s INTERFACE points at install dir; embedded build uses source + generated oslconfig).
    "${CMAKE_SOURCE_DIR}/3rdparty/osl/src/include"
    "${CMAKE_BINARY_DIR}/include"
)
target_link_libraries(otl_core PUBLIC oslexec VectorTA_rust nlohmann_json::nlohmann_json)

# High-dimensional / SIMD + fast-math (match prior OTL_Engine settings).
if(MSVC)
  target_compile_options(otl_core PUBLIC /arch:AVX2 /fp:fast)
else()
  target_compile_options(otl_core PUBLIC -mavx2 -ffast-math)
endif()

# OTL Engine: Milestone-1 (MarketDelegate, VectorTA bake, optional OSL, GAL integrator).
add_executable(OTL_Engine OTL-Core/main.cpp)
target_link_libraries(OTL_Engine PRIVATE otl_core)

# OTL-Sandbox: E2E toy (SyntheticUniverse → VectorTA → m1_alpha → closure + GA state).
add_executable(
  OTL_Sandbox
  OTL-Sandbox/main.cpp
  OTL-Sandbox/SyntheticUniverse.cpp
)
target_include_directories(OTL_Sandbox PRIVATE "${CMAKE_SOURCE_DIR}/OTL-Sandbox")
target_link_libraries(OTL_Sandbox PRIVATE otl_core)

# MSVC: match cxx / cc + Rust CRT expectations when using cxx.
if(MSVC)
  corrosion_set_env_vars(vector_ta "CFLAGS=-MD$<$<CONFIG:Debug>:d>" "CXXFLAGS=-MD$<$<CONFIG:Debug>:d>")
endif()

# GoogleTest: prefer vcpkg; otherwise fetch (so `OtlM3Node` and friends build out of the box).
option(OTL_BUILD_TESTS "Build otl_unit_tests (GTest: Integrator + Ga)" ON)
if(OTL_BUILD_TESTS)
  find_package(GTest CONFIG QUIET)
  if(NOT GTest_FOUND)
    include(FetchContent)
    set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
    set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
      googletest
      GIT_REPOSITORY https://github.com/google/googletest.git
      GIT_TAG v1.14.0
    )
    FetchContent_MakeAvailable(googletest)
  endif()
  enable_testing()
  add_subdirectory(tests)
endif()

# Help IDEs: attach folder when supported.
if(CMAKE_GENERATOR MATCHES "Visual Studio|Xcode|Ninja Multi-Config")
  set_target_properties(otl_core OTL_Engine OTL_Sandbox PROPERTIES FOLDER "OTL")
endif()
