# 用 Windows SAPI 生成默认女声提示音（原始输出，尾部静音交给 make_chimes.py 补）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make_voice.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'voice-default-raw.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice('Microsoft Huihui Desktop') } catch { }
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile($out)
$synth.Speak('主人，哦鲸鲸找你')
$synth.Dispose()
Write-Host ("voice-default-raw.wav: {0} bytes" -f (Get-Item $out).Length)
