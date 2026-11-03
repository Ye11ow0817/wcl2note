$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path $PSScriptRoot -Parent
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::Transparent)
$path = [Drawing.Drawing2D.GraphicsPath]::new()
$path.AddArc(8, 8, 96, 96, 180, 90)
$path.AddArc(152, 8, 96, 96, 270, 90)
$path.AddArc(152, 152, 96, 96, 0, 90)
$path.AddArc(8, 152, 96, 96, 90, 90)
$path.CloseFigure()
$brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#101923'))
$graphics.FillPath($brush, $path)
$pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#54c7af'), 17)
$pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$points = [Drawing.Point[]]@([Drawing.Point]::new(47,135),[Drawing.Point]::new(82,135),[Drawing.Point]::new(106,71),[Drawing.Point]::new(140,187),[Drawing.Point]::new(166,116),[Drawing.Point]::new(209,116))
$graphics.DrawLines($pen, $points)
$white = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#f3f5f7'))
$graphics.FillEllipse($white,196,103,26,26)
$bitmap.Save((Join-Path $projectRoot 'build/icon.png'), [Drawing.Imaging.ImageFormat]::Png)
$memory = [IO.MemoryStream]::new()
$bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
$data = $memory.ToArray()
$stream = [IO.File]::Create((Join-Path $projectRoot 'build/icon.ico'))
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$data.Length); $writer.Write([uint32]22); $writer.Write($data)
$writer.Dispose(); $memory.Dispose(); $white.Dispose(); $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
Write-Output 'Created build/icon.ico and build/icon.png'
