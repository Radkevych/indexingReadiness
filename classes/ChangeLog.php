<?php

/**
 * @file plugins/generic/indexingReadiness/classes/ChangeLog.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class ChangeLog
 *
 * @brief Stores applied metadata changes with their previous values so that
 *  they can be reviewed and rolled back. One JSON file per journal, kept in
 *  the OJS files directory (outside the web root).
 */

namespace APP\plugins\generic\indexingReadiness\classes;

use PKP\config\Config;

class ChangeLog
{
    protected string $path;

    public function __construct(int $contextId)
    {
        $dir = rtrim((string) Config::getVar('files', 'files_dir'), '/') . '/indexingReadiness';
        if (!is_dir($dir)) {
            @mkdir($dir, 0750, true);
        }
        $this->path = $dir . '/changes-' . $contextId . '.json';
    }

    /**
     * @return array<int, array> Newest first
     */
    public function all(): array
    {
        return array_reverse($this->read());
    }

    public function get(string $id): ?array
    {
        foreach ($this->read() as $entry) {
            if (($entry['id'] ?? '') === $id) {
                return $entry;
            }
        }
        return null;
    }

    public function add(array $entry): string
    {
        $entry['id'] = $entry['id'] ?? bin2hex(random_bytes(8));
        $this->mutate(function (array $entries) use ($entry) {
            $entries[] = $entry;
            return $entries;
        });
        return $entry['id'];
    }

    public function markRolledBack(string $id, array $info): void
    {
        $this->mutate(function (array $entries) use ($id, $info) {
            foreach ($entries as &$entry) {
                if (($entry['id'] ?? '') === $id) {
                    $entry['rolledBack'] = $info;
                }
            }
            return $entries;
        });
    }

    protected function read(): array
    {
        if (!is_file($this->path)) {
            return [];
        }
        $raw = @file_get_contents($this->path);
        $data = $raw ? json_decode($raw, true) : [];
        return is_array($data) ? $data : [];
    }

    /**
     * Read-modify-write under an exclusive lock.
     */
    protected function mutate(callable $fn): void
    {
        $handle = @fopen($this->path, 'c+');
        if (!$handle) {
            throw new \RuntimeException('Cannot open change log: ' . $this->path);
        }
        try {
            flock($handle, LOCK_EX);
            $raw = stream_get_contents($handle);
            $entries = $raw ? json_decode($raw, true) : [];
            if (!is_array($entries)) {
                $entries = [];
            }
            $entries = $fn($entries);
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, json_encode(array_values($entries), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
            fflush($handle);
            flock($handle, LOCK_UN);
        } finally {
            fclose($handle);
        }
    }
}
