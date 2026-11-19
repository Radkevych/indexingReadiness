<?php

/**
 * @file plugins/generic/indexingReadiness/classes/SkipException.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class SkipException
 *
 * @brief Signals that one proposed change cannot be applied (the reason is shown to the editor).
 */

namespace APP\plugins\generic\indexingReadiness\classes;

class SkipException extends \Exception
{
}
