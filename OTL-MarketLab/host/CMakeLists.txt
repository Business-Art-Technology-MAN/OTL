# otl_marketlab_host: C++ process that links otl_core; speaks Command Bridge on Named Pipe (Windows) or UDS (POSIX).
# No reverse link from otl_core to Market Lab.

add_executable(
  otl_marketlab_host
  src/main.cpp
  src/CommandBridge.cpp
  src/HostState.cpp
  src/OslM1Shading.cpp
)
target_include_directories(otl_marketlab_host
  PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(otl_marketlab_host PRIVATE otl_core)

if(MSVC)
  target_compile_options(otl_marketlab_host PRIVATE /arch:AVX2 /fp:fast)
else()
  target_compile_options(otl_marketlab_host PRIVATE -mavx2 -ffast-math)
endif()

if(CMAKE_GENERATOR MATCHES "Visual Studio|Xcode|Ninja Multi-Config")
  set_target_properties(otl_marketlab_host PROPERTIES FOLDER "Market Lab")
endif()

# Windows: the loader looks for DLLs next to the .exe. vector_ta / OSL / OIIO live under CMAKE_BINARY_DIR, not in host/Release.
if(WIN32)
  set(_hdir "$<TARGET_FILE_DIR:otl_marketlab_host>")
  set(_bincfg "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
  add_custom_command(
    TARGET otl_marketlab_host
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_BINARY_DIR}/vector_ta.dll" "${_hdir}/vector_ta.dll"
    COMMENT "Copy vector_ta.dll next to otl_marketlab_host"
  )
  add_custom_command(
    TARGET otl_marketlab_host
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${_bincfg}" "${_hdir}"
    COMMENT "Copy OSL/oslexec and dependency DLLs next to otl_marketlab_host (host searches local dir first)"
  )
endif()
