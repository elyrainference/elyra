// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Reg {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ElyraRegistry
/// @notice Discovery list for Elyra sellers. A wallet announces "node `nodeId` (box key `boxKey`) is reachable at
///         `url`" for a limited time; buyers read the `Announced` / `Revoked` logs and then verify every claim by
///         talking to the node (signed /p2p/hello). The chain stores no trust: only who said what, until when.
///         No admin keys, no upgradability, no slashing, nobody can delist or move anyone else's funds. Unaudited.
/// @dev    State per wallet is just the expiry of its latest announcement (the content lives in the event log, which
///         keeps gas small). An optional bond (`bondAmount`, 0 = off) in an ERC-20 is locked while the wallet has
///         announced and leaves through the escrow's delayed, single-use withdraw pattern. The bond only prices
///         Sybil spam; it is never confiscated.
contract ElyraRegistry {
    address public immutable token;
    uint256 public immutable bondAmount;

    uint64 public constant DEFAULT_TTL = 7 days;
    uint64 public constant MIN_TTL = 1 hours;
    uint64 public constant MAX_TTL = 30 days;
    uint256 public constant MAX_URL_LENGTH = 256;
    uint256 public constant WITHDRAW_DELAY = 1 days;
    uint256 public constant WITHDRAW_WINDOW = 7 days;

    mapping(address => uint64) public expiresAt;   // 0 = not listed
    mapping(address => uint256) public bonded;
    mapping(address => uint256) public withdrawAt;
    mapping(address => uint256) public withdrawExpires;

    uint256 private _lock = 1;

    event Announced(address indexed wallet, bytes32 nodeId, bytes32 boxKey, string url, bytes32 metaHash, uint64 expiresAt);
    event Revoked(address indexed wallet);
    event BondPosted(address indexed wallet, uint256 amount);
    event WithdrawRequested(address indexed wallet, uint256 availableAt);
    event WithdrawCancelled(address indexed wallet);
    event BondWithdrawn(address indexed wallet, uint256 amount);

    error Reentrancy();
    error ZeroNodeId();
    error BadUrlLength();
    error BadTtl();
    error NotListed();
    error NothingBonded();
    error WithdrawNotRequested();
    error WithdrawLocked(uint256 availableAt);
    error WithdrawExpired();
    error TransferMismatch();
    error TokenTransferFailed();
    error BadConfig();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param token_ ERC-20 used for the bond (may be zero only when `bondAmount_` is 0).
    constructor(address token_, uint256 bondAmount_) {
        if (bondAmount_ != 0 && token_ == address(0)) revert BadConfig();
        token = token_;
        bondAmount = bondAmount_;
    }

    /// @notice List (or refresh) the caller's node. `ttl` seconds from now; 0 = DEFAULT_TTL. If a bond is configured
    ///         and not yet posted, it is pulled from the caller (needs prior approval).
    function announce(bytes32 nodeId, bytes32 boxKey, string calldata url, bytes32 metaHash, uint64 ttl) external nonReentrant {
        if (nodeId == bytes32(0)) revert ZeroNodeId();
        uint256 len = bytes(url).length;
        if (len == 0 || len > MAX_URL_LENGTH) revert BadUrlLength();
        if (ttl == 0) ttl = DEFAULT_TTL;
        if (ttl < MIN_TTL || ttl > MAX_TTL) revert BadTtl();

        uint64 until = uint64(block.timestamp) + ttl;
        expiresAt[msg.sender] = until;
        // listing again withdraws any pending exit of the bond
        if (withdrawAt[msg.sender] != 0) {
            withdrawAt[msg.sender] = 0;
            withdrawExpires[msg.sender] = 0;
            emit WithdrawCancelled(msg.sender);
        }
        emit Announced(msg.sender, nodeId, boxKey, url, metaHash, until);

        uint256 have = bonded[msg.sender];
        if (have < bondAmount) {
            uint256 need = bondAmount - have;
            uint256 before = IERC20Reg(token).balanceOf(address(this));
            _safeCall(abi.encodeCall(IERC20Reg.transferFrom, (msg.sender, address(this), need)));
            if (IERC20Reg(token).balanceOf(address(this)) - before != need) revert TransferMismatch();
            bonded[msg.sender] = bondAmount;
            emit BondPosted(msg.sender, need);
        }
    }

    /// @notice Unlist the caller now. The bond (if any) stays until requestWithdraw + withdraw.
    function revoke() external {
        if (expiresAt[msg.sender] == 0) revert NotListed();
        expiresAt[msg.sender] = 0;
        emit Revoked(msg.sender);
    }

    function isListed(address wallet) external view returns (bool) {
        return expiresAt[wallet] > block.timestamp;
    }

    /// @notice Start the bond exit timer and unlist now: withdrawable from now + WITHDRAW_DELAY until WITHDRAW_WINDOW later.
    function requestWithdraw() external {
        if (bonded[msg.sender] == 0) revert NothingBonded();
        if (expiresAt[msg.sender] != 0) {
            expiresAt[msg.sender] = 0;
            emit Revoked(msg.sender);
        }
        uint256 at = block.timestamp + WITHDRAW_DELAY;
        withdrawAt[msg.sender] = at;
        withdrawExpires[msg.sender] = at + WITHDRAW_WINDOW;
        emit WithdrawRequested(msg.sender, at);
    }

    function cancelWithdraw() external {
        withdrawAt[msg.sender] = 0;
        withdrawExpires[msg.sender] = 0;
        emit WithdrawCancelled(msg.sender);
    }

    /// @notice Single-use: succeeds only inside [withdrawAt, withdrawExpires]; returns the whole bond and clears the request.
    function withdraw() external nonReentrant {
        uint256 at = withdrawAt[msg.sender];
        if (at == 0) revert WithdrawNotRequested();
        if (block.timestamp < at) revert WithdrawLocked(at);
        if (block.timestamp > withdrawExpires[msg.sender]) revert WithdrawExpired();
        uint256 amount = bonded[msg.sender];
        withdrawAt[msg.sender] = 0;
        withdrawExpires[msg.sender] = 0;
        bonded[msg.sender] = 0;
        emit BondWithdrawn(msg.sender, amount);
        if (amount != 0) _safeCall(abi.encodeCall(IERC20Reg.transfer, (msg.sender, amount)));
    }

    /// @dev Calls the token; accepts empty return data or a true bool, reverts otherwise.
    function _safeCall(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || token.code.length == 0 || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenTransferFailed();
        }
    }
}
