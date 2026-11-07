@echo off
rem AutoED 启动脚本
rem 注意：清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会被当成纯 Node 运行，
rem 表现为窗口一闪而过、什么都不显示。
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
