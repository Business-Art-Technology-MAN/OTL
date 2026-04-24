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
corrosion_add_cxxbridge(
  otl_vector_ta_cxx
  CRATE vector_ta
  MANIFEST_PATH "${CMAKE_SOURCE_DIR}/3rdparty/VectorTA"
  FILES
    src/bridge.rs
  REGEN_TARGET otl_regen_cxx_vector_ta
)

# 1. GAL (header-only): point at the GAL 'include' or 'src' tree (repo-relative).
include_directories(3rdparty/gal/include)

# Project naming: "VectorTA-rust" in docs = Corrosion cxx target (Rust + generated C++ from bridge.rs).
# CMake target names must not use '-'; this alias is the link surface for the Rust/VectorTA stack.
add_library(VectorTA_rust ALIAS otl_vector_ta_cxx)

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
)
target_include_directories(otl_core PUBLIC "${CMAKE_SOURCE_DIR}/OTL-Core")
target_link_libraries(otl_core PUBLIC oslexec VectorTA_rust)

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

# GoogleTest: from vcpkg (`vcpkg install gtest`); see OTL_ENGINEERING_TESTING_REFERENCE.md.
option(OTL_BUILD_TESTS "Build otl_unit_tests (GTest: Integrator + Ga)" ON)
if(OTL_BUILD_TESTS)
  find_package(GTest CONFIG REQUIRED)
  enable_testing()
  add_subdirectory(tests)
endif()

# Help IDEs: attach folder when supported.
if(CMAKE_GENERATOR MATCHES "Visual Studio|Xcode|Ninja Multi-Config")
  set_target_properties(otl_core OTL_Engine OTL_Sandbox PROPERTIES FOLDER "OTL")
endif()
