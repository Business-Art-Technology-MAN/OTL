# Integrator + GA portfolio tests: pure C++ + GAL (no OSL / Rust / VectorTA link).

add_executable(otl_unit_tests
  IntegratorTests.cpp
  Phase2Tests.cpp
  AnalyticsM3Tests.cpp
  "${CMAKE_SOURCE_DIR}/OTL-Core/otl/GaPortfolioIntegrator.cpp"
  "${CMAKE_SOURCE_DIR}/OTL-Core/otl/OtlGeometricMetrics.cpp"
  "${CMAKE_SOURCE_DIR}/OTL-Core/otl/OtlAnalytics.cpp"
)

target_include_directories(otl_unit_tests
  PRIVATE
  "${CMAKE_SOURCE_DIR}/OTL-Core"
)

if(MSVC)
  target_compile_options(otl_unit_tests PRIVATE /arch:AVX2)
else()
  target_compile_options(otl_unit_tests PRIVATE -mavx2)
endif()

target_link_libraries(otl_unit_tests
  PRIVATE
  GTest::gtest_main
)

add_test(NAME GaPortfolioUnit COMMAND otl_unit_tests)
# Windows: gtest is built as DLL next to the test exe under bin/Release; add to PATH for ctest.
if(WIN32)
  if(DEFINED VCPKG_INSTALLED_DIR)
    set(_otl_vcpkg_bin "${VCPKG_INSTALLED_DIR}/x64-windows/bin")
  else()
    set(_otl_vcpkg_bin "")
  endif()
  set(_otl_gtest_path "${CMAKE_BINARY_DIR}/bin/Release;${CMAKE_BINARY_DIR}/bin/Debug;${CMAKE_BINARY_DIR}/tests/Release;${CMAKE_BINARY_DIR}/tests/Debug")
  if(_otl_vcpkg_bin)
    string(APPEND _otl_gtest_path ";${_otl_vcpkg_bin}")
  endif()
  set_property(TEST GaPortfolioUnit
    APPEND
    PROPERTY
      ENVIRONMENT
        "PATH=${_otl_gtest_path}")
endif()

# M3: OtlNodeSystem (JSON + VectorTA); requires full otl_core link.
add_executable(otl_m3_node_tests
  OtlNodeSystemTests.cpp
)
if(MSVC)
  target_compile_options(otl_m3_node_tests PRIVATE /arch:AVX2)
else()
  target_compile_options(otl_m3_node_tests PRIVATE -mavx2)
endif()
target_include_directories(otl_m3_node_tests
  PRIVATE
  "${CMAKE_SOURCE_DIR}/OTL-Core"
)
target_link_libraries(otl_m3_node_tests
  PRIVATE
  otl_core
  GTest::gtest_main
)
add_test(NAME OtlM3Node COMMAND otl_m3_node_tests)
# Windows: link Rust/OSL + deps DLLs (vector_ta in build root; oslexec/gtest in bin/<Config>).
if(WIN32)
  if(DEFINED VCPKG_INSTALLED_DIR)
    set(_otl_vcpkg_bin "${VCPKG_INSTALLED_DIR}/x64-windows/bin")
  else()
    set(_otl_vcpkg_bin "")
  endif()
  set(_otl_m3_path "${CMAKE_BINARY_DIR}\\;${CMAKE_BINARY_DIR}/bin/Release\\;${CMAKE_BINARY_DIR}/bin/Debug")
  if(_otl_vcpkg_bin)
    string(APPEND _otl_m3_path "\\;${_otl_vcpkg_bin}")
  endif()
  set_property(TEST OtlM3Node
    APPEND
    PROPERTY
      ENVIRONMENT
        "PATH=${_otl_m3_path}")
endif()

# Market Lab: `LOAD_DATA.timeline_axis` tick sampling (standalone; JSON + STL only — no otl_core).
if(EXISTS "${CMAKE_SOURCE_DIR}/OTL-MarketLab/host/src/TimelineAxisJson.cpp")
  add_executable(mlab_timeline_axis_tests
    MarketLabTimelineAxisTests.cpp
    "${CMAKE_SOURCE_DIR}/OTL-MarketLab/host/src/TimelineAxisJson.cpp"
  )
  target_include_directories(mlab_timeline_axis_tests
    PRIVATE
    "${CMAKE_SOURCE_DIR}/OTL-MarketLab/host/include"
  )
  target_link_libraries(mlab_timeline_axis_tests
    PRIVATE
    GTest::gtest_main
    nlohmann_json::nlohmann_json
  )
  add_test(NAME MarketLabTimelineAxis COMMAND mlab_timeline_axis_tests)
  if(MSVC AND CMAKE_GENERATOR MATCHES "Visual Studio|Xcode|Ninja Multi-Config")
    set_property(TARGET mlab_timeline_axis_tests PROPERTY FOLDER "Market Lab")
  endif()
  if(WIN32)
    if(DEFINED VCPKG_INSTALLED_DIR)
      set(_otl_vcpkg_bin "${VCPKG_INSTALLED_DIR}/x64-windows/bin")
    else()
      set(_otl_vcpkg_bin "")
    endif()
    set(_tl_path "${CMAKE_BINARY_DIR}/bin/Release;${CMAKE_BINARY_DIR}/bin/Debug;${CMAKE_BINARY_DIR}/tests/Release;${CMAKE_BINARY_DIR}/tests/Debug")
    if(_otl_vcpkg_bin)
      string(APPEND _tl_path ";${_otl_vcpkg_bin}")
    endif()
    set_property(TEST MarketLabTimelineAxis
      APPEND
      PROPERTY
        ENVIRONMENT
          "PATH=${_tl_path}")
  endif()
endif()
