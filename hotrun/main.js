"ui";

var RELEASE_PAGE_URL = 'https://gitee.com/Renvy/assttyys_autojs/releases/latest?force_mobile=true';
var UPDATE_ASSET_NAME = 'assttyys_ng.zip';
var FALLBACK_UPDATE_URL = 'https://assttyys.renvy.top/assttyys_ng.zip';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36 Edg/91.0.864.59';
var basePath = context.getExternalFilesDir(null).getAbsolutePath() + '/assttyus_ng';
var appPath = basePath + '/assttyys_ng';
var appEntryPath = appPath + '/dist/auto.js';
var metadataPath = basePath + '/assttyys_ng.update.json';
var updateZipPath = basePath + '/assttyys_ng.update.zip';
var stagingRootPath = basePath + '/assttyys_ng.update';
var stagingAppPath = stagingRootPath + '/assttyys_ng';
var stagingEntryPath = stagingAppPath + '/dist/auto.js';
var backupAppPath = basePath + '/assttyys_ng.backup';
var backupEntryPath = backupAppPath + '/dist/auto.js';

// 设置状态栏为透明
activity.getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
if (device.sdkInt >= 23) {
    activity.getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
}
ui.layout(
    <frame>
        <vertical w="*" h="*" layout_gravity="center">
            <vertical h="*" gravity="center" >
                <img src="file://./res/ysc_splashIcon.png" w="120" h="120" scaleType="fitXY"/>
                <horizontal gravity="center" margin="25">
                    <text id="loadingtext">加载中，请稍后</text>
                </horizontal>
            </vertical>
        </vertical>
    </frame>
);

var loadingMessage = '正在检查更新';
var loadingDotCount = 0;
setInterval(function () {
    loadingDotCount = (loadingDotCount + 1) % 5;
    ui.loadingtext.text(loadingMessage + (new Array(loadingDotCount + 1)).join('.'));
}, 400);

function setLoadingMessage(message) {
    loadingMessage = message;
    loadingDotCount = 0;
}

function isLocalProgramAvailable() {
    return files.isFile(appEntryPath);
}

function removePath(targetPath) {
    if (!files.exists(targetPath)) return;
    if (files.isDir(targetPath)) {
        files.removeDir(targetPath);
    } else {
        files.remove(targetPath);
    }
}

function movePath(sourcePath, targetPath) {
    var moved = files.move(sourcePath, targetPath);
    if (moved === false || !files.exists(targetPath)) {
        throw new Error('移动文件失败: ' + sourcePath + ' -> ' + targetPath);
    }
}

function copyDirectory(sourcePath, targetPath) {
    files.ensureDir(targetPath + '/');
    var names = files.listDir(sourcePath) || [];
    names.forEach(function (name) {
        var sourceChildPath = sourcePath + '/' + name;
        var targetChildPath = targetPath + '/' + name;
        if (files.isDir(sourceChildPath)) {
            copyDirectory(sourceChildPath, targetChildPath);
        } else {
            files.ensureDir(targetChildPath);
            var copied = files.copy(sourceChildPath, targetChildPath);
            if (copied === false || !files.exists(targetChildPath)) {
                throw new Error('复制插件文件失败: ' + sourceChildPath);
            }
        }
    });
}

function readUpdateMetadata() {
    if (!files.isFile(metadataPath)) return null;
    try {
        var metadata = JSON.parse(files.read(metadataPath));
        if (!metadata || (!metadata.createdAt && !metadata.etag && !metadata.lastModified)) return null;
        return metadata;
    } catch (error) {
        console.warn('读取更新元数据失败，将重新下载完整更新包', error);
        return null;
    }
}

function writeUpdateMetadata(metadata) {
    if (!metadata.createdAt && !metadata.etag && !metadata.lastModified) {
        removePath(metadataPath);
        return;
    }
    files.ensureDir(metadataPath);
    files.write(metadataPath, JSON.stringify(metadata));
}

function getResponseHeader(response, headerName) {
    var headers = response && response.headers;
    if (!headers) return '';

    if (typeof headers.get === 'function') {
        var value = headers.get(headerName);
        if (value !== null && value !== undefined) return String(value);
    }

    var expectedName = headerName.toLowerCase();
    for (var name in headers) {
        if (String(name).toLowerCase() === expectedName) {
            var headerValue = headers[name];
            return headerValue === null || headerValue === undefined ? '' : String(headerValue);
        }
    }
    return '';
}

function closeResponse(response) {
    try {
        if (response && response.body && typeof response.body.close === 'function') {
            response.body.close();
        }
    } catch (error) {
        console.warn('关闭更新响应失败', error);
    }
}

function toAbsoluteGiteeUrl(url) {
    var absoluteUrl = String(url || '');
    if (absoluteUrl.indexOf('//') === 0) {
        return 'https:' + absoluteUrl;
    }
    if (absoluteUrl.indexOf('/') === 0) {
        return 'https://gitee.com' + absoluteUrl;
    }
    return absoluteUrl;
}

function recoverInterruptedUpdate() {
    var localAvailable = isLocalProgramAvailable();
    var backupAvailable = files.isFile(backupEntryPath);

    if (!localAvailable && backupAvailable) {
        setLoadingMessage('正在恢复本地程序');
        removePath(appPath);
        movePath(backupAppPath, appPath);
    } else if (localAvailable && files.exists(backupAppPath)) {
        // 新版本已经完成替换；插件在替换前已复制到新目录，可以清理旧备份。
        removePath(backupAppPath);
    }

    removePath(updateZipPath);
    removePath(stagingRootPath);
}

function installUpdate(archiveBytes) {
    var oldProgramMoved = false;
    var updateInstalled = false;

    removePath(updateZipPath);
    removePath(stagingRootPath);
    files.ensureDir(updateZipPath);
    files.writeBytes(updateZipPath, archiveBytes);

    try {
        setLoadingMessage('正在解压更新');
        files.ensureDir(stagingRootPath + '/');
        $zip.unzip(updateZipPath, stagingRootPath);
        if (!files.isFile(stagingEntryPath)) {
            throw new Error('更新包缺少入口文件 dist/auto.js');
        }

        var currentPluginsPath = appPath + '/plugins';
        var backupPluginsPath = backupAppPath + '/plugins';
        var stagingPluginsPath = stagingAppPath + '/plugins';
        if (files.isDir(currentPluginsPath)) {
            removePath(stagingPluginsPath);
            copyDirectory(currentPluginsPath, stagingPluginsPath);
        } else if (files.isDir(backupPluginsPath)) {
            removePath(stagingPluginsPath);
            copyDirectory(backupPluginsPath, stagingPluginsPath);
        }

        setLoadingMessage('正在安装更新');
        removePath(backupAppPath);
        if (files.exists(appPath)) {
            movePath(appPath, backupAppPath);
            oldProgramMoved = true;
        }

        movePath(stagingAppPath, appPath);
        if (!isLocalProgramAvailable()) {
            throw new Error('更新安装后入口文件不可用');
        }

        updateInstalled = true;
        removePath(backupAppPath);
    } catch (error) {
        if (oldProgramMoved && files.exists(backupAppPath)) {
            removePath(appPath);
            movePath(backupAppPath, appPath);
        }
        throw error;
    } finally {
        removePath(updateZipPath);
        removePath(stagingRootPath);
        if (updateInstalled) removePath(backupAppPath);
    }
}

function getLatestRelease() {
    var response = null;
    try {
        var requestHeaders = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html'
        };
        response = http.get(RELEASE_PAGE_URL, { headers: requestHeaders });
        if (response.statusCode >= 300 && response.statusCode < 400) {
            var redirectUrl = toAbsoluteGiteeUrl(getResponseHeader(response, 'Location'));
            closeResponse(response);
            response = null;
            if (!redirectUrl) {
                throw new Error('Gitee Release 页面重定向地址无效');
            }
            response = http.get(redirectUrl, { headers: requestHeaders });
        }
        if (response.statusCode !== 200) {
            throw new Error('Gitee Release 页面返回状态码 ' + response.statusCode);
        }

        var html = response.body.string();
        var escapedAssetName = UPDATE_ASSET_NAME.replace(/\./g, '\\.');
        var tagMatch = html.match(/data-tag-name=['"]([^'"]+)['"]/i);
        var createdAtMatch = html.match(/<span[^>]*class=['"]release-time['"][^>]*>\s*([^<]+?)\s*<\/span>/i);
        var createdAtMarkerMatch = html.match(/ASSTTYYS_CREATED_AT=([0-9T:+.\-]+)/i);
        var legacyCreatedAtMatch = html.match(new RegExp("Automated deployment of " + escapedAssetName + " at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\.", 'i'));
        var downloadMatch = html.match(new RegExp("href=['\"]([^'\"]*/releases/download/[^'\"]+/" + escapedAssetName + ")['\"]", 'i'));
        if (!tagMatch || !createdAtMatch || !downloadMatch) {
            throw new Error('Gitee Release 页面格式无法识别');
        }

        var downloadUrl = toAbsoluteGiteeUrl(downloadMatch[1]);

        return {
            tagName: String(tagMatch[1]),
            createdAt: String(createdAtMarkerMatch ? createdAtMarkerMatch[1] : (legacyCreatedAtMatch ? legacyCreatedAtMatch[1] : createdAtMatch[1])).replace(/^\s+|\s+$/g, ''),
            downloadUrl: downloadUrl
        };
    } catch (error) {
        if (error && error.message && error.message.indexOf('Gitee') === 0) throw error;
        throw new Error('解析最新 Release 失败: ' + error);
    } finally {
        closeResponse(response);
    }
}

function downloadArchive(downloadUrl, sourceName) {
    var response = null;
    try {
        response = http.get(downloadUrl, {
            headers: {
                'User-Agent': USER_AGENT
            }
        });
        if (response.statusCode !== 200) {
            throw new Error(sourceName + '返回状态码 ' + response.statusCode);
        }

        var archiveBytes = response.body.bytes();
        if (!archiveBytes || archiveBytes.length === 0) {
            throw new Error(sourceName + '下载的更新包为空');
        }
        return {
            bytes: archiveBytes,
            etag: getResponseHeader(response, 'ETag'),
            lastModified: getResponseHeader(response, 'Last-Modified')
        };
    } finally {
        closeResponse(response);
    }
}

function checkForUpdate() {
    var localAvailable = isLocalProgramAvailable();
    var metadata = readUpdateMetadata();

    setLoadingMessage('正在检查更新');
    var release = getLatestRelease();
    if (localAvailable && metadata && metadata.createdAt === release.createdAt) {
        return;
    }

    setLoadingMessage(localAvailable ? '正在下载更新' : '正在下载程序');
    var archive = null;
    var downloadedFromGitee = false;
    try {
        archive = downloadArchive(release.downloadUrl, 'Gitee');
        downloadedFromGitee = true;
    } catch (giteeError) {
        console.warn('Gitee 附件下载失败，切换备用源', giteeError);
        setLoadingMessage('正在切换备用下载源');
        archive = downloadArchive(FALLBACK_UPDATE_URL, '备用源');
    }

    installUpdate(archive.bytes);
    if (downloadedFromGitee) {
        writeUpdateMetadata({
            createdAt: release.createdAt,
            tagName: release.tagName
        });
    } else {
        // 备用源无法证明与 Gitee Release 版本完全一致，下次启动仍会重新核验。
        writeUpdateMetadata({
            etag: archive.etag,
            lastModified: archive.lastModified
        });
    }
}

function showUpdateFailureDialog(error, localAvailable) {
    var latch = new java.util.concurrent.CountDownLatch(1);
    var choice = 'exit';
    var errorMessage = error && error.message ? error.message : String(error);
    if (errorMessage.length > 500) errorMessage = errorMessage.substring(0, 500);

    ui.run(function () {
        var dialog = dialogs.build({
            title: '更新失败',
            content: errorMessage,
            positive: '重试',
            negative: localAvailable ? '直接进入' : '退出',
            cancelable: false,
            canceledOnTouchOutside: false,
            autoDismiss: false
        });
        dialog.on('positive', function () {
            choice = 'retry';
            dialog.dismiss();
            latch.countDown();
        });
        dialog.on('negative', function () {
            choice = localAvailable ? 'enter' : 'exit';
            dialog.dismiss();
            latch.countDown();
        });
        dialog.show();
    });

    latch.await();
    return choice;
}

function startLocalProgram() {
    if (!isLocalProgramAvailable()) {
        throw new Error('本地程序入口不存在');
    }
    setLoadingMessage('正在进入程序');
    engines.execScriptFile(appEntryPath, {
        path: appPath
    });
    setTimeout(function () {
        ui.finish();
    }, 1000);
}

function closeLauncher() {
    ui.run(function () {
        ui.finish();
    });
}

threads.start(function () {
    var packageName = context.packageName;
    if (false && packageName.match(/^org.autojs.autojs(pro)?$/)) {
        sleep(2000);
        // 在 AJ 中运行时使用仓库构建产物。
        engines.execScriptFile(files.cwd() + '/../dist/auto.js', {
            path: files.cwd() + '/../'
        });
        setTimeout(function () {
            ui.finish();
        }, 1000);
        return;
    }

    try {
        recoverInterruptedUpdate();
    } catch (error) {
        console.error('恢复更新现场失败', error);
    }

    while (true) {
        try {
            checkForUpdate();
            startLocalProgram();
            return;
        } catch (error) {
            console.error('检查或安装更新失败', error);
            var localAvailable = isLocalProgramAvailable();
            var choice = showUpdateFailureDialog(error, localAvailable);
            if (choice === 'retry') continue;
            if (choice === 'enter') {
                try {
                    startLocalProgram();
                } catch (startError) {
                    console.error('启动本地程序失败', startError);
                    toastLog('启动本地程序失败: ' + startError);
                    closeLauncher();
                }
                return;
            }
            closeLauncher();
            return;
        }
    }
});
