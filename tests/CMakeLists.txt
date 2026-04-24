# Integrator + GA portfolio tests: pure C++ + GAL (no OSL / Rust / VectorTA link).

add_executable(otl_unit_tests
  IntegratorTests.cpp
  "${CMAKE_SOURCE_DIR}/OTL-Core/otl/GaPortfolioIntegrator.cpp"
)

target_include_directories(otl_unit_tests
  PRIVATE
  "${CMAKE_SOURCE_DIR}/OTL-Core"
  "${CMAKE_SOURCE_DIR}/3rdparty/gal/include"
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
