@echo off
@CHCP 65001 >nul
REM ============================================================
REM  水上俱乐部 · 一键同步并推送到 GitHub
REM  用法：双击运行，或在命令行传入提交说明
REM        deploy.bat "修复了某某问题"
REM  注意：本文件必须保存为 UTF-8 无 BOM 编码，否则中文会乱码
REM ============================================================

setlocal
cd /d "%~dp0"

set SRC=..\shuishang.html
set DST=index.html

echo ============================================================
echo   水上俱乐部 - 同步到 GitHub
echo ============================================================
echo.

REM 1. 检查源文件是否存在
if not exist "%SRC%" (
    echo [错误] 找不到源文件 %SRC%
    echo        请确认 shuishang.html 在上级目录中
    echo.
    pause
    exit /b 1
)

REM 2. 同步文件
echo [1/4] 正在同步 shuishang.html -^> index.html ...
copy /Y "%SRC%" "%DST%" >nul
if %errorlevel% neq 0 (
    echo [错误] 文件复制失败
    pause
    exit /b 1
)
echo       完成

REM 3. 加入暂存区
echo [2/4] 正在加入 Git 暂存区 ...
git add -A
if %errorlevel% neq 0 (
    echo [错误] git add 失败，请确认已安装 Git
    pause
    exit /b 1
)
echo       完成

REM 4. 提交（用传入的说明，或默认带时间戳的说明）
echo [3/4] 正在提交 ...
if "%~1"=="" (
    git commit -m "更新水上俱乐部结算工具 %date% %time%"
) else (
    git commit -m "%~1"
)
if %errorlevel% neq 0 (
    echo [提示] 没有需要提交的更改，或提交失败
)

REM 5. 推送
echo [4/4] 正在推送到 GitHub ...
git push
if %errorlevel% neq 0 (
    echo.
    echo [错误] 推送失败，请检查网络或 GitHub 授权是否过期
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   推送成功！
echo   访问：https://USER.github.io/shuishang/
echo ============================================================
echo.
pause
endlocal
